import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  Tool,
  CallToolResult,
  TextContent,
  ImageContent,
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
import { detectVSCodeAsync, type VSCodeEnvironment } from "./vscode-integration.js";
import { sendIpcRequest } from "./ipc-socket.js";
import {
  type BrowserSession,
  createCdpSession,
  createBidiSession,
} from "./browser-session.js";
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
      "List all detected browsers on this system (Chrome, Edge, Chromium, Brave, Firefox).",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "coordinator_status",
    description:
      "Get the current status of the browser coordinator: whether a browser is running, the CDP proxy port, VS Code integration, and IPC connection state.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "coordinator_launch_browser",
    description:
      "Explicitly launch or relaunch the browser. Normally the browser launches automatically when a CDP connection arrives at the proxy. Use this to switch browser type, toggle headless mode, or force a restart. When VS Code extension is active, use browserType to force an external browser.",
    inputSchema: {
      type: "object",
      properties: {
        browserType: {
          type: "string",
          description: "Browser type: chrome, edge, chromium, brave, firefox. If omitted and VS Code extension is active, uses VS Code's browser.",
          enum: ["chrome", "edge", "chromium", "brave", "firefox"],
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
  {
    name: "coordinator_navigate",
    description:
      "Navigate the browser to a URL. If VS Code extension is active, opens in Simple Browser. Otherwise navigates via the browser protocol (CDP or BiDi).",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to navigate to",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "coordinator_select_element",
    description:
      "Activate an element picker in the browser. Returns information about the selected element including tag name, attributes, CSS selector, text content, and bounding box. Works with both VS Code's Simple Browser and external browsers.",
    inputSchema: {
      type: "object",
      properties: {
        timeout: {
          type: "number",
          description: "Timeout in milliseconds (default: 30000)",
        },
      },
      required: [],
    },
  },
  {
    name: "coordinator_get_dom",
    description:
      "Get the rendered DOM tree or a subtree as HTML. Includes shadow DOM content when the browser supports Element.getHTML() (Chrome 124+, Firefox 128+). If no selector is given, returns the entire document HTML (truncated to a reasonable size).",
    inputSchema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector for a specific element (optional)",
        },
        depth: {
          type: "number",
          description: "Maximum depth to traverse (optional)",
        },
      },
      required: [],
    },
  },
  {
    name: "coordinator_screenshot",
    description:
      "Capture a screenshot of the current page or a specific region. Saves to disk and returns the file path and image.",
    inputSchema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector for a specific element (optional)",
        },
        format: {
          type: "string",
          description: "Image format (default: png)",
          enum: ["png", "jpeg"],
        },
        clip: {
          type: "object",
          description: "Explicit pixel crop rect. Takes precedence over selector.",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            width: { type: "number" },
            height: { type: "number" },
          },
          required: ["x", "y", "width", "height"],
        },
        fullPage: {
          type: "boolean",
          description: "Capture entire scrollable page, not just viewport (default: false). Ignored when clip or selector is set.",
        },
        outputDir: {
          type: "string",
          description: "Directory to save screenshot. Defaults to a workspace-stable temp directory.",
        },
      },
      required: [],
    },
  },
  {
    name: "coordinator_get_markdown",
    description:
      "Get the page content as Markdown. Uses Turndown.js to convert rendered HTML to clean Markdown. " +
      "Strips scripts, styles, SVGs, and hidden elements. Useful for extracting readable content from web pages.",
    inputSchema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector to convert a specific element (optional, defaults to body)",
        },
      },
      required: [],
    },
  },
  {
    name: "coordinator_fetch",
    description:
      "Execute an HTTP request through the browser's network stack. " +
      "Preserves cookies, user agent, and session state. Bypasses CORS. " +
      "Returns JSON with status, statusText, headers, and body.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch" },
        method: {
          type: "string",
          description: "HTTP method (default: GET)",
        },
        headers: {
          type: "object",
          description: "Request headers as key-value pairs",
          additionalProperties: { type: "string" },
        },
        body: {
          type: "string",
          description: "Request body (for POST, PUT, PATCH, etc.)",
        },
        timeout: {
          type: "number",
          description: "Timeout in milliseconds (default: 30000)",
        },
      },
      required: ["url"],
    },
  },
];

function textResult(text: string): CallToolResult {
  return {
    content: [{ type: "text", text } as TextContent],
  };
}

/**
 * Workspace-stable screenshot directory under os.tmpdir().
 * Uses a SHA-256 hash of cwd (truncated to 12 hex chars) so each project
 * gets its own screenshot folder, matching the state.ts convention.
 */
function getScreenshotDir(): string {
  const hash = crypto.createHash("sha256").update(process.cwd()).digest("hex").slice(0, 12);
  return path.join(os.tmpdir(), "browser-coordinator", "screenshots", hash);
}

/**
 * Generate a filesystem-safe screenshot filename with ISO timestamp.
 */
function screenshotFilename(format: string): string {
  const ts = new Date().toISOString().replace(/:/g, "-");
  return `screenshot-${ts}.${format === "jpeg" ? "jpg" : format}`;
}

// ─── Coordinator Server ─────────────────────────────────────────────────────

export class CoordinatorServer {
  private server: Server;
  private cdpProxy: CdpProxy;
  private browserInstance: BrowserInstance | null = null;
  private vsCodeEnv: VSCodeEnvironment = {
    detected: false, cdpPort: null, terminalIntegration: false,
    ipcSocketPath: null, extensionVersion: null, activeBrowserUrl: null,
  };
  private opts: CoordinatorOptions;

  constructor(opts: CoordinatorOptions = {}) {
    this.opts = opts;

    this.server = new Server(
      {
        name: "browser-coordinator",
        version: "0.3.0",
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
   */
  async initialize(): Promise<void> {
    // Detect VS Code environment (async — tries IPC first)
    if (!this.opts.noVscode) {
      this.vsCodeEnv = await detectVSCodeAsync();
    }

    // Start CDP proxy on a free port
    const proxyPort = await this.cdpProxy.listen(0);

    // Set up lazy launch callback
    this.cdpProxy.onLazyLaunch(async () => {
      // If extension is active, use VS Code's CDP port
      if (this.vsCodeEnv.ipcSocketPath && this.vsCodeEnv.cdpPort) {
        log("Lazy launch: using VS Code's CDP port");
        return this.vsCodeEnv.cdpPort;
      }
      return this.launchBrowserInternal();
    });

    // If VS Code extension provides CDP port, use it as backend
    if (this.vsCodeEnv.cdpPort) {
      this.cdpProxy.setBackend(this.vsCodeEnv.cdpPort);
      log(`Using VS Code CDP port: ${this.vsCodeEnv.cdpPort}`);
    }

    // Write state file
    writeState({ port: proxyPort, pid: process.pid });

    log(`Coordinator initialized. CDP proxy on port ${proxyPort}. Browser will launch on first connection.`);
  }

  private setupHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [...COORDINATOR_TOOLS],
      };
    });

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
   * Launch a browser and return its internal port.
   */
  private async launchBrowserInternal(launchOpts?: LauncherOptions): Promise<number> {
    const opts = launchOpts ?? this.opts.browser;
    const port = await getFreePort();

    log("Launching browser...");
    this.browserInstance = await launchBrowser(port, opts);
    log(`Browser launched: ${this.browserInstance.browser.name} (${this.browserInstance.engine}) on internal port ${port}`);

    return port;
  }

  /**
   * Get a BrowserSession for the active browser.
   *
   * Creates a new session each time (sessions are short-lived per tool call).
   * For Chromium: connects via CDP to the backend or proxy port.
   * For Firefox: connects via BiDi WebSocket URL from the browser instance.
   * For VS Code: always Chromium/CDP via the proxy.
   */
  private async getSession(): Promise<BrowserSession> {
    // Firefox path: use BiDi session
    if (this.browserInstance?.engine === "firefox" && this.browserInstance.bidiWsUrl) {
      return createBidiSession(this.browserInstance.bidiWsUrl);
    }

    // Chromium path (including VS Code): use CDP session
    const proxyPort = this.cdpProxy.getPort();
    const backendPort = this.cdpProxy.getBackendPort();
    const port = backendPort ?? proxyPort;
    return createCdpSession(port);
  }

  /**
   * Send an IPC request to the extension, with retry on failure.
   */
  private async sendIpc(type: string, payload?: Record<string, unknown>): Promise<boolean> {
    if (!this.vsCodeEnv.ipcSocketPath) return false;

    try {
      await sendIpcRequest(this.vsCodeEnv.ipcSocketPath, {
        id: `${type}-${Date.now()}`,
        type: type as import("./ipc-types.js").IpcRequestType,
        payload,
      });
      return true;
    } catch (err) {
      logError(`IPC request ${type} failed`, err);
      // Retry once — socket may have been recreated
      try {
        await sendIpcRequest(this.vsCodeEnv.ipcSocketPath, {
          id: `${type}-retry-${Date.now()}`,
          type: type as import("./ipc-types.js").IpcRequestType,
          payload,
        });
        return true;
      } catch {
        log(`IPC retry failed for ${type} — falling back`);
        return false;
      }
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
        const lines: string[] = [];

        // Show VS Code browser first if extension is active
        if (this.vsCodeEnv.ipcSocketPath) {
          lines.push("- VS Code Browser (built-in, via extension IPC) [active]");
        }

        if (browsers.length === 0 && lines.length === 0) {
          return textResult("No browsers found on this system.");
        }

        for (const b of browsers) {
          const protocol = b.supportsBidi ? "(BiDi)" : b.supportsCDP ? "(CDP)" : "";
          lines.push(`- ${b.name} (${b.type}) ${protocol} → ${b.path}`);
        }
        return textResult(`Detected browsers:\n${lines.join("\n")}`);
      }

      case "coordinator_status": {
        const browserRunning = this.browserInstance?.process.killed === false;
        const extensionActive = !!this.vsCodeEnv.ipcSocketPath;

        let browserStatus: string;
        if (extensionActive && !browserRunning) {
          browserStatus = "VS Code Simple Browser" + (this.vsCodeEnv.activeBrowserUrl ? ` (${this.vsCodeEnv.activeBrowserUrl})` : "");
        } else if (browserRunning) {
          const engineLabel = this.browserInstance!.engine === "firefox" ? "BiDi" : "CDP";
          browserStatus = `Running (${this.browserInstance!.browser.name}, ${engineLabel}, internal port ${this.browserInstance!.cdpPort})`;
        } else {
          browserStatus = "Not running (will launch on first CDP connection)";
        }

        const vsCodeStatus = extensionActive
          ? `Extension active (IPC connected, v${this.vsCodeEnv.extensionVersion})`
          : this.vsCodeEnv.detected
            ? "Detected (no extension IPC)"
            : "Not detected";

        return textResult(
          [
            `Browser: ${browserStatus}`,
            `CDP Proxy Port: ${this.cdpProxy.getPort()}`,
            `VS Code: ${vsCodeStatus}`,
          ].join("\n")
        );
      }

      case "coordinator_launch_browser": {
        const browserType = args.browserType as string | undefined;

        // If extension is active and no explicit browserType, use VS Code browser
        if (!browserType && this.vsCodeEnv.ipcSocketPath) {
          return textResult(
            "Using VS Code browser. Use coordinator_navigate to open a URL.\n" +
            "To force an external browser, specify browserType (e.g. chrome, firefox)."
          );
        }

        // Stop existing browser if running
        if (this.browserInstance && !this.browserInstance.process.killed) {
          stopBrowser(this.browserInstance);
          this.browserInstance = null;
        }

        const launchOpts: LauncherOptions = {
          ...this.opts.browser,
          browserType,
          headless: args.headless as boolean | undefined,
        };

        const internalPort = await this.launchBrowserInternal(launchOpts);

        // For Chromium: update proxy backend. For Firefox: proxy has no backend.
        if (this.browserInstance!.engine === "chromium") {
          this.cdpProxy.setBackend(internalPort);
          this.cdpProxy.closeConnections();
        } else {
          // Firefox: clear CDP proxy backend (child MCPs won't work)
          this.cdpProxy.clearBackend();
          this.cdpProxy.closeConnections();
        }

        const engineLabel = this.browserInstance!.engine === "firefox" ? "BiDi" : "CDP";
        return textResult(
          `Browser launched: ${this.browserInstance!.browser.name} (${engineLabel}, proxy port ${this.cdpProxy.getPort()}, internal port ${internalPort})`
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

          if (this.browserInstance!.engine === "chromium") {
            this.cdpProxy.setBackend(internalPort);
          } else {
            this.cdpProxy.clearBackend();
          }
          this.cdpProxy.closeConnections();

          return textResult(
            `Browser restarted (proxy port ${this.cdpProxy.getPort()}, internal port ${internalPort})`
          );
        }
        return textResult("No browser was running. Browser will launch on next CDP connection.");
      }

      case "coordinator_navigate": {
        const url = args.url as string;
        if (!url) {
          return textResult("Error: url is required");
        }

        // Try IPC first (VS Code Simple Browser)
        if (this.vsCodeEnv.ipcSocketPath) {
          const ok = await this.sendIpc("navigate", { url });
          if (ok) {
            this.vsCodeEnv.activeBrowserUrl = url;
            return textResult(`Navigated to ${url} (VS Code Simple Browser)`);
          }
        }

        // Fall back to browser session
        let session: BrowserSession | undefined;
        try {
          session = await this.getSession();
          await session.navigate(url);
          return textResult(`Navigated to ${url} (via ${session.engine === "firefox" ? "BiDi" : "CDP"})`);
        } catch (err) {
          return textResult(`Failed to navigate: ${err instanceof Error ? err.message : err}`);
        } finally {
          await session?.close();
        }
      }

      case "coordinator_select_element": {
        const timeout = (args.timeout as number) ?? 30000;

        // Notify extension about element selection
        if (this.vsCodeEnv.ipcSocketPath) {
          await this.sendIpc("start_element_select");
        }

        let session: BrowserSession | undefined;
        try {
          session = await this.getSession();
          const value = await session.selectElement(timeout);

          // Cancel selection state in extension
          if (this.vsCodeEnv.ipcSocketPath) {
            await this.sendIpc("cancel_element_select");
          }

          try {
            const element = JSON.parse(value);
            if (element.error) {
              return textResult(`Element selection failed: ${element.error}`);
            }
            return textResult(JSON.stringify(element, null, 2));
          } catch {
            return textResult(`Unexpected picker result: ${value}`);
          }
        } catch (err) {
          // Cancel selection state on error
          if (this.vsCodeEnv.ipcSocketPath) {
            await this.sendIpc("cancel_element_select");
          }
          return textResult(`Element selection failed: ${err instanceof Error ? err.message : err}`);
        } finally {
          await session?.close();
        }
      }

      case "coordinator_get_dom": {
        const selector = args.selector as string | undefined;
        const depth = args.depth as number | undefined;

        let session: BrowserSession | undefined;
        try {
          session = await this.getSession();
          const html = await session.getRenderedDOM({ selector, depth });
          return textResult(html);
        } catch (err) {
          return textResult(`Failed to get DOM: ${err instanceof Error ? err.message : err}`);
        } finally {
          await session?.close();
        }
      }

      case "coordinator_screenshot": {
        const selector = args.selector as string | undefined;
        const format = (args.format as "png" | "jpeg") ?? "png";
        const clipArg = args.clip as { x: number; y: number; width: number; height: number } | undefined;
        const fullPage = (args.fullPage as boolean) ?? false;
        const outputDir = args.outputDir as string | undefined;

        let session: BrowserSession | undefined;
        try {
          session = await this.getSession();
          const result = await session.screenshot({
            selector,
            format,
            clip: clipArg,
            fullPage,
          });

          // Save to disk
          const dir = outputDir ?? getScreenshotDir();
          fs.mkdirSync(dir, { recursive: true });
          const filename = screenshotFilename(result.format);
          const filePath = path.join(dir, filename);
          fs.writeFileSync(filePath, Buffer.from(result.data, "base64"));

          const mimeType = result.format === "jpeg" ? "image/jpeg" : "image/png";
          return {
            content: [
              { type: "text", text: `Screenshot saved to ${filePath}` } as TextContent,
              { type: "image", data: result.data, mimeType } as ImageContent,
            ],
          };
        } catch (err) {
          return textResult(`Screenshot failed: ${err instanceof Error ? err.message : err}`);
        } finally {
          await session?.close();
        }
      }

      case "coordinator_get_markdown": {
        const selector = args.selector as string | undefined;

        let session: BrowserSession | undefined;
        try {
          session = await this.getSession();
          const md = await session.getMarkdown({ selector });
          return textResult(md);
        } catch (err) {
          return textResult(`Failed to get markdown: ${err instanceof Error ? err.message : err}`);
        } finally {
          await session?.close();
        }
      }

      case "coordinator_fetch": {
        const url = args.url as string;
        if (!url) {
          return textResult("Error: url is required");
        }

        let session: BrowserSession | undefined;
        try {
          session = await this.getSession();
          const result = await session.browserFetch({
            url,
            method: (args.method as string) ?? "GET",
            headers: (args.headers as Record<string, string>) ?? {},
            body: args.body as string | undefined,
            timeout: (args.timeout as number) ?? 30000,
          });
          return textResult(result);
        } catch (err) {
          return textResult(`coordinator_fetch failed: ${err instanceof Error ? err.message : err}`);
        } finally {
          await session?.close();
        }
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
