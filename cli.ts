#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CoordinatorServer, type CoordinatorOptions } from "./coordinator-server.js";
import { logError } from "./log.js";

function parseArgs(): CoordinatorOptions {
  const args = process.argv.slice(2);
  const opts: CoordinatorOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--mcp" && args[i + 1]) {
      // Custom child MCP: --mcp <command> [args...]
      // e.g. --mcp @playwright/mcp@latest
      // e.g. --mcp "node /path/to/my-mcp.js"
      const mcpSpec = args[i + 1];
      const remaining = args.slice(i + 2);

      // Check if it's a scoped npm package or path
      if (mcpSpec.startsWith("@") || mcpSpec.startsWith(".") || mcpSpec.startsWith("/")) {
        opts.childMcp = {
          command: "npx",
          args: ["-y", mcpSpec, ...remaining],
        };
      } else {
        opts.childMcp = {
          command: mcpSpec,
          args: remaining,
        };
      }
      break; // Everything after --mcp is for the child
    }

    if (arg === "--browser" && args[i + 1]) {
      opts.browser = { ...opts.browser, browserType: args[++i] };
    }

    if (arg === "--browser-path" && args[i + 1]) {
      opts.browser = { ...opts.browser, browserPath: args[++i] };
    }

    if (arg === "--no-headless") {
      opts.browser = { ...opts.browser, headless: false };
    }

    if (arg === "--no-vscode") {
      opts.noVscode = true;
    }

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return opts;
}

function printHelp(): void {
  console.error(`
browser-coordinator-mcp — MCP server that coordinates browser lifecycle

USAGE:
  npx @anthropic-community/browser-coordinator-mcp [options]

OPTIONS:
  --mcp <package>     Child MCP server to proxy (default: @anthropic-ai/mcp-server-playwright)
  --browser <type>    Preferred browser: chrome, edge, chromium, brave
  --browser-path <p>  Explicit path to browser executable
  --no-headless       Launch browser with UI (not headless)
  --no-vscode         Skip VS Code environment detection
  --help, -h          Show this help

EXAMPLES:
  # Default — uses Playwright MCP, auto-detects browser
  npx @anthropic-community/browser-coordinator-mcp

  # Custom child MCP
  npx @anthropic-community/browser-coordinator-mcp --mcp @anthropic-ai/mcp-server-playwright@latest

  # Force Edge, with UI visible
  npx @anthropic-community/browser-coordinator-mcp --browser edge --no-headless

CLAUDE CODE CONFIG (claude_desktop_config.json / .mcp.json):
  {
    "mcpServers": {
      "browser": {
        "command": "npx",
        "args": ["-y", "@anthropic-community/browser-coordinator-mcp"]
      }
    }
  }

ENVIRONMENT:
  BROWSER_COORDINATOR_DEBUG=1  Enable debug logging to stderr
  VSCODE_CDP_PORT=<port>       VS Code CDP port (set by companion extension)
`);
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const coordinator = new CoordinatorServer(opts);

  // Initialize (pre-allocate port, spawn child MCP — no browser yet)
  await coordinator.initialize();

  // Connect to stdio transport
  const transport = new StdioServerTransport();
  await coordinator.getServer().connect(transport);

  // Graceful shutdown
  const shutdown = async () => {
    await coordinator.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGHUP", shutdown);

  // Handle child process crashes
  process.on("uncaughtException", (err) => {
    logError("Uncaught exception", err);
    shutdown();
  });
}

main().catch((err) => {
  logError("Fatal error during startup", err);
  process.exit(1);
});
