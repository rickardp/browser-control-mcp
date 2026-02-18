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
import { CdpProxy } from "./cdp-proxy.js";
import { writeState, clearState } from "./state.js";
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
  /** Browser launch options */
  browser?: LauncherOptions;
  /** Skip VS Code detection */
  noVscode?: boolean;
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
      "Get the current status of the browser coordinator: whether a browser is running, the CDP proxy port, and VS Code integration tier.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "coordinator_launch_browser",
    description:
      "Explicitly launch or relaunch the browser. Normally the browser launches automatically when a CDP connection arrives at the proxy. Use this to switch browser type, toggle headless mode, or force a restart.",
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
      "Restart the browser. Kills the current instance and launches a new one. The CDP proxy port stays the same — child MCPs reconnect automatically.",
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
  private cdpProxy: CdpProxy;
  private browserInstance: BrowserInstance | null = null;
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

    this.cdpProxy = new CdpProxy();
    this.setupHandlers();
  }

  /**
   * Initialize: start CDP proxy, detect VS Code, write state file.
   * No browser is launched — that's deferred to first CDP connection or explicit tool call.
   */
  async initialize(): Promise<void> {
    // Detect VS Code environment
    if (!this.opts.noVscode) {
      this.vsCodeEnv = detectVSCode();
    }

    // Start CDP proxy on a free port
    const proxyPort = await this.cdpProxy.listen(0);

    // Set up lazy launch callback — triggered when a CDP connection arrives
    // and no browser is running
    this.cdpProxy.onLazyLaunch(async () => {
      return this.launchBrowserInternal();
    });

    // If VS Code Tier 2, use its CDP port as the backend directly
    if (this.vsCodeEnv.cdpPort) {
      this.cdpProxy.setBackend(this.vsCodeEnv.cdpPort);
      log(`Using VS Code CDP port: ${this.vsCodeEnv.cdpPort}`);
    }

    // Write state file so `wrap` subcommand can find the port
    writeState({ port: proxyPort, pid: process.pid });

    log(`Coordinator initialized. CDP proxy on port ${proxyPort}. Browser will launch on first connection.`);
  }

  private setupHandlers(): void {
    // tools/list — only coordinator tools (no child MCP merging)
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [...COORDINATOR_TOOLS],
      };
    });

    // tools/call — coordinator tools only
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const toolArgs = (args ?? {}) as Record<string, unknown>;

      if (name.startsWith("coordinator_")) {
        return this.handleCoordinatorTool(name, toolArgs);
      }

      return textResult(`Unknown tool: ${name}`);
    });
  }

  /**
   * Launch a browser and return its CDP port.
   * Used by both lazy launch (CDP proxy callback) and explicit tool calls.
   */
  private async launchBrowserInternal(launchOpts?: LauncherOptions): Promise<number> {
    const opts = launchOpts ?? this.opts.browser;
    const port = await getFreePort();

    log("Launching browser...");
    this.browserInstance = await launchBrowser(port, opts);
    log(`Browser launched: ${this.browserInstance.browser.name} on internal port ${port}`);

    return port;
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
        const browserRunning = this.browserInstance?.process.killed === false;
        const browserStatus = browserRunning
          ? `Running (${this.browserInstance!.browser.name}, internal port ${this.browserInstance!.cdpPort})`
          : "Not running (will launch on first CDP connection)";

        const tier = this.vsCodeEnv.cdpPort
          ? "Tier 2 (VS Code native CDP)"
          : this.vsCodeEnv.detected
            ? "Tier 1 (external browser + VS Code preview)"
            : "Standard (external browser)";

        return textResult(
          [
            `Browser: ${browserStatus}`,
            `CDP Proxy Port: ${this.cdpProxy.getPort()}`,
            `VS Code: ${tier}`,
          ].join("\n")
        );
      }

      case "coordinator_launch_browser": {
        // Stop existing browser if running
        if (this.browserInstance && !this.browserInstance.process.killed) {
          stopBrowser(this.browserInstance);
          this.browserInstance = null;
        }

        const launchOpts: LauncherOptions = {
          ...this.opts.browser,
          browserType: args.browserType as string | undefined,
          headless: args.headless as boolean | undefined,
        };

        const internalPort = await this.launchBrowserInternal(launchOpts);

        // Update proxy backend and close existing connections
        this.cdpProxy.setBackend(internalPort);
        this.cdpProxy.closeConnections();

        return textResult(
          `Browser launched: ${this.browserInstance!.browser.name} (CDP proxy port ${this.cdpProxy.getPort()}, internal port ${internalPort})`
        );
      }

      case "coordinator_stop_browser": {
        if (this.browserInstance) {
          stopBrowser(this.browserInstance);
          this.browserInstance = null;
          this.cdpProxy.clearBackend();
          this.cdpProxy.closeConnections();
          return textResult("Browser stopped.");
        }
        return textResult("No browser is running.");
      }

      case "coordinator_restart_browser": {
        if (this.browserInstance) {
          const prevOpts: LauncherOptions = {
            ...this.opts.browser,
          };

          stopBrowser(this.browserInstance);
          this.browserInstance = null;

          const internalPort = await this.launchBrowserInternal(prevOpts);

          // Update proxy backend and close existing connections
          this.cdpProxy.setBackend(internalPort);
          this.cdpProxy.closeConnections();

          return textResult(
            `Browser restarted (CDP proxy port ${this.cdpProxy.getPort()}, internal port ${internalPort})`
          );
        }
        return textResult("No browser was running. Browser will launch on next CDP connection.");
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

    await this.cdpProxy.close();
    clearState();

    log("Coordinator shut down.");
  }
}
