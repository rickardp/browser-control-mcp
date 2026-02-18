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
import { connectToTarget, getTargets, type CdpClient } from "./cdp-client.js";
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
          description: "Browser type: chrome, edge, chromium, brave. If omitted and VS Code extension is active, uses VS Code's browser.",
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
  {
    name: "coordinator_navigate",
    description:
      "Navigate the browser to a URL. If VS Code extension is active, opens in Simple Browser. Otherwise sends Page.navigate via CDP.",
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
      "Get the DOM tree or a subtree as HTML. If no selector is given, returns the entire document HTML (truncated to a reasonable size).",
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
      "Capture a screenshot of the current page or a specific element. Returns a base64-encoded image.",
    inputSchema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description: "CSS selector for a specific element (optional — captures full page if omitted)",
        },
        format: {
          type: "string",
          description: "Image format (default: png)",
          enum: ["png", "jpeg"],
        },
      },
      required: [],
    },
  },
];

function textResult(text: string): CallToolResult {
  return {
    content: [{ type: "text", text } as TextContent],
  };
}

function imageResult(base64: string, mimeType: "image/png" | "image/jpeg"): CallToolResult {
  return {
    content: [{ type: "image", data: base64, mimeType } as ImageContent],
  };
}

// ─── Element picker script ──────────────────────────────────────────────────

const ELEMENT_PICKER_JS = `
(function() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.id = '__bc_picker_overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:2147483647;cursor:crosshair;';

    const highlight = document.createElement('div');
    highlight.id = '__bc_picker_highlight';
    highlight.style.cssText = 'position:fixed;pointer-events:none;border:2px solid #4A90D9;background:rgba(74,144,217,0.15);z-index:2147483646;display:none;';
    document.body.appendChild(highlight);

    let lastTarget = null;

    overlay.addEventListener('mousemove', (e) => {
      overlay.style.pointerEvents = 'none';
      const el = document.elementFromPoint(e.clientX, e.clientY);
      overlay.style.pointerEvents = 'auto';
      if (el && el !== overlay && el !== highlight) {
        lastTarget = el;
        const rect = el.getBoundingClientRect();
        highlight.style.left = rect.left + 'px';
        highlight.style.top = rect.top + 'px';
        highlight.style.width = rect.width + 'px';
        highlight.style.height = rect.height + 'px';
        highlight.style.display = 'block';
      }
    });

    overlay.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      overlay.remove();
      highlight.remove();

      if (!lastTarget) {
        resolve(JSON.stringify({ error: 'No element selected' }));
        return;
      }

      const el = lastTarget;
      const rect = el.getBoundingClientRect();
      const attrs = {};
      for (const a of el.attributes) attrs[a.name] = a.value;

      // Generate CSS selector
      let selector = el.tagName.toLowerCase();
      if (el.id) selector += '#' + el.id;
      for (const cls of el.classList) selector += '.' + cls;

      // If selector is not unique, add nth-child
      if (!el.id && document.querySelectorAll(selector).length > 1) {
        const parent = el.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children);
          const idx = siblings.indexOf(el) + 1;
          selector += ':nth-child(' + idx + ')';
        }
      }

      resolve(JSON.stringify({
        tagName: el.tagName.toLowerCase(),
        attributes: attrs,
        textContent: (el.textContent || '').trim().slice(0, 200),
        cssSelector: selector,
        boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        nodeId: 0
      }));
    });

    document.body.appendChild(overlay);
  });
})()
`;

// ─── DOM depth limiter script ───────────────────────────────────────────────

function getDomScript(selector?: string, depth?: number): string {
  if (selector && depth) {
    return `
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return 'Element not found: ${selector}';
        function limit(node, d) {
          if (d <= 0) return '';
          const clone = node.cloneNode(false);
          if (d > 1) {
            for (const child of node.children) {
              clone.appendChild(limit(child, d - 1).cloneNode ? limit(child, d - 1) : document.createTextNode(''));
            }
          }
          const wrap = document.createElement('div');
          wrap.appendChild(clone);
          return wrap.innerHTML;
        }
        return limit(el, ${depth});
      })()
    `;
  }
  if (selector) {
    return `
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        return el ? el.outerHTML : 'Element not found: ${selector}';
      })()
    `;
  }
  // Full document — truncate
  return `document.documentElement.outerHTML.slice(0, 100000)`;
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
        version: "0.2.0",
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
   * Launch a browser and return its CDP port.
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
   * Get a CDP client connected to the active browser target.
   */
  private async getCdpClient(): Promise<{ client: CdpClient; cleanup: () => void }> {
    const proxyPort = this.cdpProxy.getPort();
    const backendPort = this.cdpProxy.getBackendPort();

    // Prefer direct connection to backend for CDP operations
    const port = backendPort ?? proxyPort;

    const { client } = await connectToTarget(port);
    return {
      client,
      cleanup: () => client.close(),
    };
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
          return textResult("No CDP-capable browsers found on this system.");
        }

        for (const b of browsers) {
          lines.push(`- ${b.name} (${b.type}) → ${b.path}`);
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
          browserStatus = `Running (${this.browserInstance!.browser.name}, internal port ${this.browserInstance!.cdpPort})`;
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
            "To force an external browser, specify browserType (e.g. chrome)."
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

          this.cdpProxy.setBackend(internalPort);
          this.cdpProxy.closeConnections();

          return textResult(
            `Browser restarted (CDP proxy port ${this.cdpProxy.getPort()}, internal port ${internalPort})`
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

        // Fall back to CDP
        try {
          const { client, cleanup } = await this.getCdpClient();
          try {
            await client.send("Page.navigate", { url });
            return textResult(`Navigated to ${url} (via CDP)`);
          } finally {
            cleanup();
          }
        } catch (err) {
          return textResult(`Failed to navigate: ${err instanceof Error ? err.message : err}`);
        }
      }

      case "coordinator_select_element": {
        const timeout = (args.timeout as number) ?? 30000;

        // Notify extension about element selection
        if (this.vsCodeEnv.ipcSocketPath) {
          await this.sendIpc("start_element_select");
        }

        try {
          const { client, cleanup } = await this.getCdpClient();
          try {
            // Inject the element picker script
            const result = await client.send("Runtime.evaluate", {
              expression: ELEMENT_PICKER_JS,
              awaitPromise: true,
              returnByValue: true,
              timeout,
            }) as { result?: { value?: string } };

            // Cancel selection state in extension
            if (this.vsCodeEnv.ipcSocketPath) {
              await this.sendIpc("cancel_element_select");
            }

            const value = result?.result?.value;
            if (!value) {
              return textResult("Element selection returned no result.");
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
          } finally {
            cleanup();
          }
        } catch (err) {
          // Cancel selection state on error
          if (this.vsCodeEnv.ipcSocketPath) {
            await this.sendIpc("cancel_element_select");
          }
          return textResult(`Element selection failed: ${err instanceof Error ? err.message : err}`);
        }
      }

      case "coordinator_get_dom": {
        const selector = args.selector as string | undefined;
        const depth = args.depth as number | undefined;

        try {
          const { client, cleanup } = await this.getCdpClient();
          try {
            const script = getDomScript(selector, depth);
            const result = await client.send("Runtime.evaluate", {
              expression: script,
              returnByValue: true,
            }) as { result?: { value?: string } };

            const html = result?.result?.value;
            if (!html) {
              return textResult("No DOM content returned.");
            }
            return textResult(html);
          } finally {
            cleanup();
          }
        } catch (err) {
          return textResult(`Failed to get DOM: ${err instanceof Error ? err.message : err}`);
        }
      }

      case "coordinator_screenshot": {
        const selector = args.selector as string | undefined;
        const format = (args.format as string) ?? "png";

        try {
          const { client, cleanup } = await this.getCdpClient();
          try {
            let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;

            // If selector provided, get the element's bounding box
            if (selector) {
              const boxResult = await client.send("Runtime.evaluate", {
                expression: `
                  (function() {
                    const el = document.querySelector(${JSON.stringify(selector)});
                    if (!el) return null;
                    const rect = el.getBoundingClientRect();
                    return JSON.stringify({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
                  })()
                `,
                returnByValue: true,
              }) as { result?: { value?: string } };

              const boxJson = boxResult?.result?.value;
              if (!boxJson) {
                return textResult(`Element not found: ${selector}`);
              }
              const box = JSON.parse(boxJson);
              clip = { ...box, scale: 1 };
            }

            const result = await client.send("Page.captureScreenshot", {
              format,
              ...(clip ? { clip } : {}),
            }) as { data?: string };

            if (!result?.data) {
              return textResult("Screenshot returned no data.");
            }

            const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";
            return imageResult(result.data, mimeType);
          } finally {
            cleanup();
          }
        } catch (err) {
          return textResult(`Screenshot failed: ${err instanceof Error ? err.message : err}`);
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
