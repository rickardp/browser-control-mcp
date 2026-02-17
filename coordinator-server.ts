import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  Tool,
  CallToolResult,
  TextContent,
} from "@modelcontextprotocol/sdk/types.js";
import { McpProxy, type ChildMcpConfig } from "./mcp-proxy.js";
import {
  getFreePort,
  launchBrowser,
  stopBrowser,
  type BrowserInstance,
  type LauncherOptions,
} from "./browser-launcher.js";
import { detectBrowsers } from "./browser-detector.js";
import { detectVSCode, type VSCodeEnvironment } from "./vscode-integration.js";
import { log, logError } from "./log.js";

export interface CoordinatorOptions {
  /** Child MCP server config (e.g. @playwright/mcp) */
  childMcp?: ChildMcpConfig;
  /** Browser launch options */
  browser?: LauncherOptions;
  /** Skip VS Code detection */
  noVscode?: boolean;
}

/**
 * Builds the child MCP config from CLI args or defaults.
 * Default: npx @playwright/mcp@latest --cdp-endpoint=http://localhost:<port>
 */
function buildChildMcpConfig(port: number, opts?: ChildMcpConfig): ChildMcpConfig {
  if (opts) {
    // Inject the CDP endpoint into the args
    const hasEndpoint = opts.args.some((a) => a.includes("--cdp-endpoint"));
    return {
      ...opts,
      args: hasEndpoint
        ? opts.args
        : [...opts.args, `--cdp-endpoint=http://localhost:${port}`],
    };
  }

  // Default: Playwright MCP
  return {
    command: "npx",
    args: [
      "-y",
      "@anthropic-ai/mcp-server-playwright@latest",
      "--cdp-endpoint",
      `http://localhost:${port}`,
    ],
  };
}

// ─── Coordinator tool definitions ───────────────────────────────────────────

const COORDINATOR_TOOLS: Tool[] = [
  {
    name: "coordinator_list_browsers",
    description:
      "List all CDP-capable browsers detected on this system (Chrome, Edge, Chromium, Brave).",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "coordinator_status",
    description:
      "Get the current status of the browser coordinator: whether a browser is running, the CDP endpoint, VS Code integration tier, and child MCP status.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "coordinator_launch_browser",
    description:
      "Explicitly launch or relaunch the browser. Normally the browser launches automatically on first browser tool call. Use this to switch browser type, toggle headless mode, or force a restart.",
    inputSchema: {
      type: "object",
      properties: {
        browserType: {
          type: "string",
          description: "Browser type: chrome, edge, chromium, brave",
          enum: ["chrome", "edge", "chromium", "brave"],
        },
        headless: {
          type: "boolean",
          description: "Run in headless mode (default: true)",
        },
      },
      required: [],
    },
  },
  {
    name: "coordinator_stop_browser",
    description: "Stop the running browser and clean up resources.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "coordinator_restart_browser",
    description:
      "Restart the browser. Kills the current instance and launches a new one on the same port.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
];

function textResult(text: string): CallToolResult {
  return {
    content: [{ type: "text", text } as TextContent],
  };
}

// ─── Coordinator Server ─────────────────────────────────────────────────────

export class CoordinatorServer {
  private server: Server;
  private proxy: McpProxy | null = null;
  private browserInstance: BrowserInstance | null = null;
  private preAllocatedPort: number = 0;
  private browserLaunching = false;
  private vsCodeEnv: VSCodeEnvironment = { detected: false, cdpPort: null, terminalIntegration: false };
  private opts: CoordinatorOptions;

  constructor(opts: CoordinatorOptions = {}) {
    this.opts = opts;

    this.server = new Server(
      {
        name: "browser-coordinator",
        version: "0.1.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  /**
   * Initialize: pre-allocate port, detect VS Code, spawn child MCP.
   * No browser is launched — that's deferred to first tool call.
   */
  async initialize(): Promise<void> {
    // Detect VS Code environment
    if (!this.opts.noVscode) {
      this.vsCodeEnv = detectVSCode();
    }

    // Pre-allocate the CDP port
    if (this.vsCodeEnv.cdpPort) {
      // Tier 2: Use VS Code's existing CDP port
      this.preAllocatedPort = this.vsCodeEnv.cdpPort;
      log(`Using VS Code CDP port: ${this.preAllocatedPort}`);
    } else {
      // Tier 1: Allocate our own port for external browser
      this.preAllocatedPort = await getFreePort();
      log(`Pre-allocated CDP port: ${this.preAllocatedPort}`);
    }

    // Build child MCP config with the port
    const childConfig = buildChildMcpConfig(this.preAllocatedPort, this.opts.childMcp);

    // Spawn child MCP — tools become available immediately
    // (Playwright MCP connects lazily, so no browser needed yet)
    this.proxy = new McpProxy(childConfig);
    await this.proxy.connect();

    log("Coordinator initialized. Browser will launch on first tool call.");
  }

  private setupHandlers(): void {
    // tools/list — merge coordinator tools + child MCP tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const childTools = this.proxy?.getTools() ?? [];
      return {
        tools: [...COORDINATOR_TOOLS, ...childTools],
      };
    });

    // tools/call — route to coordinator or child
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const toolArgs = (args ?? {}) as Record<string, unknown>;

      // Coordinator tools
      if (name.startsWith("coordinator_")) {
        return this.handleCoordinatorTool(name, toolArgs);
      }

      // Child MCP tools — ensure browser is running first
      if (this.proxy?.hasTool(name)) {
        await this.ensureBrowserRunning();
        return this.proxy.callTool(name, toolArgs);
      }

      return textResult(`Unknown tool: ${name}`);
    });
  }

  /**
   * Ensure a browser is running on the pre-allocated port.
   * Called before any child MCP tool invocation (lazy launch).
   */
  private async ensureBrowserRunning(): Promise<void> {
    // Already running?
    if (this.browserInstance && !this.browserInstance.process.killed) {
      return;
    }

    // Tier 2: VS Code's browser is already running
    if (this.vsCodeEnv.cdpPort) {
      log("Tier 2: Using VS Code's CDP endpoint directly.");
      return;
    }

    // Prevent concurrent launches
    if (this.browserLaunching) {
      // Wait for ongoing launch
      while (this.browserLaunching) {
        await new Promise((r) => setTimeout(r, 100));
      }
      return;
    }

    this.browserLaunching = true;
    try {
      log("Lazy launching browser...");
      this.browserInstance = await launchBrowser(this.preAllocatedPort, this.opts.browser);
      log("Browser launched successfully.");
    } catch (err) {
      logError("Failed to launch browser", err);
      throw err;
    } finally {
      this.browserLaunching = false;
    }
  }

  /**
   * Handle coordinator-specific tool calls.
   */
  private async handleCoordinatorTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<CallToolResult> {
    switch (name) {
      case "coordinator_list_browsers": {
        const browsers = detectBrowsers();
        if (browsers.length === 0) {
          return textResult("No CDP-capable browsers found on this system.");
        }
        const lines = browsers.map(
          (b) => `- ${b.name} (${b.type}) → ${b.path}`
        );
        return textResult(`Detected browsers:\n${lines.join("\n")}`);
      }

      case "coordinator_status": {
        const browserStatus = this.browserInstance?.process.killed === false
          ? `Running (${this.browserInstance.browser.name}, port ${this.browserInstance.cdpPort})`
          : "Not running (will launch on first browser tool call)";

        const tier = this.vsCodeEnv.cdpPort
          ? "Tier 2 (VS Code native CDP)"
          : this.vsCodeEnv.detected
            ? "Tier 1 (external browser + VS Code preview)"
            : "Standard (external browser)";

        const childStatus = this.proxy?.isConnected ? "Connected" : "Disconnected";

        return textResult(
          [
            `Browser: ${browserStatus}`,
            `CDP Port: ${this.preAllocatedPort}`,
            `VS Code: ${tier}`,
            `Child MCP: ${childStatus}`,
            `Child Tools: ${this.proxy?.getTools().length ?? 0}`,
          ].join("\n")
        );
      }

      case "coordinator_launch_browser": {
        // Stop existing browser if running
        if (this.browserInstance && !this.browserInstance.process.killed) {
          stopBrowser(this.browserInstance);
          this.browserInstance = null;
        }

        // Allocate a new port if switching browsers
        this.preAllocatedPort = await getFreePort();

        const launchOpts: LauncherOptions = {
          ...this.opts.browser,
          browserType: args.browserType as string | undefined,
          headless: args.headless as boolean | undefined,
        };

        this.browserInstance = await launchBrowser(this.preAllocatedPort, launchOpts);

        // Reconnect child MCP with new port
        await this.proxy?.disconnect();
        const childConfig = buildChildMcpConfig(this.preAllocatedPort, this.opts.childMcp);
        this.proxy = new McpProxy(childConfig);
        await this.proxy.connect();

        return textResult(
          `Browser launched: ${this.browserInstance.browser.name} on port ${this.preAllocatedPort}`
        );
      }

      case "coordinator_stop_browser": {
        if (this.browserInstance) {
          stopBrowser(this.browserInstance);
          this.browserInstance = null;
          return textResult("Browser stopped.");
        }
        return textResult("No browser is running.");
      }

      case "coordinator_restart_browser": {
        if (this.browserInstance) {
          const wasHeadless = this.opts.browser?.headless;
          stopBrowser(this.browserInstance);
          this.browserInstance = null;

          this.preAllocatedPort = await getFreePort();
          this.browserInstance = await launchBrowser(this.preAllocatedPort, {
            ...this.opts.browser,
            headless: wasHeadless,
          });

          // Reconnect child MCP
          await this.proxy?.disconnect();
          const childConfig = buildChildMcpConfig(this.preAllocatedPort, this.opts.childMcp);
          this.proxy = new McpProxy(childConfig);
          await this.proxy.connect();

          return textResult(
            `Browser restarted on port ${this.preAllocatedPort}`
          );
        }
        return textResult("No browser was running. Use a browser tool to auto-launch.");
      }

      default:
        return textResult(`Unknown coordinator tool: ${name}`);
    }
  }

  /**
   * Get the underlying MCP server for transport connection.
   */
  getServer(): Server {
    return this.server;
  }

  /**
   * Graceful shutdown.
   */
  async shutdown(): Promise<void> {
    log("Shutting down coordinator...");

    if (this.browserInstance) {
      stopBrowser(this.browserInstance);
      this.browserInstance = null;
    }

    await this.proxy?.disconnect();

    log("Coordinator shut down.");
  }
}
