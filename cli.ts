#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CoordinatorServer, type CoordinatorOptions } from "./coordinator-server.js";
import { readState } from "./state.js";
import { spawn } from "node:child_process";
import { logError } from "./log.js";

export function parseArgs(): CoordinatorOptions {
  const args = process.argv.slice(2);
  const opts: CoordinatorOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

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

/**
 * Parse the `wrap` subcommand arguments.
 * Everything after `--` is the child command.
 *
 * Returns null if this is not a `wrap` invocation.
 */
export function parseWrapArgs(): { childCommand: string; childArgs: string[] } | null {
  const args = process.argv.slice(2);

  if (args[0] !== "wrap") return null;

  const dashDashIdx = args.indexOf("--");
  if (dashDashIdx === -1 || dashDashIdx === args.length - 1) {
    console.error("Error: wrap requires -- followed by a child command");
    console.error("Usage: browser-coordinator-mcp wrap -- <command> [args...]");
    process.exit(1);
  }

  const childParts = args.slice(dashDashIdx + 1);
  return {
    childCommand: childParts[0],
    childArgs: childParts.slice(1),
  };
}

/**
 * Replace template variables in args:
 *   {cdp_port} → port number
 *   {cdp_endpoint} → http://localhost:<port>
 */
export function injectPort(args: string[], port: number): string[] {
  return args.map((arg) =>
    arg
      .replace(/\{cdp_port\}/g, String(port))
      .replace(/\{cdp_endpoint\}/g, `http://localhost:${port}`)
  );
}

function printHelp(): void {
  console.error(`
browser-coordinator-mcp — MCP server that coordinates browser lifecycle

USAGE:
  npx @anthropic-community/browser-coordinator-mcp [options]
  npx @anthropic-community/browser-coordinator-mcp wrap -- <command> [args...]

MODES:
  (default)   Start the coordinator MCP server
  wrap        Read coordinator state, inject CDP port into child command, run it

OPTIONS:
  --browser <type>    Preferred browser: chrome, edge, chromium, brave
  --browser-path <p>  Explicit path to browser executable
  --no-headless       Launch browser with UI (not headless)
  --no-vscode         Skip VS Code environment detection
  --help, -h          Show this help

WRAP SUBCOMMAND:
  Reads the coordinator's CDP proxy port from its state file, replaces
  {cdp_port} and {cdp_endpoint} in the child command args, then spawns
  the child with stdio inherited (transparent passthrough to the host).

  Template variables:
    {cdp_port}      → replaced with the proxy port number (e.g. 41837)
    {cdp_endpoint}  → replaced with http://localhost:<port>

EXAMPLES:
  # Start coordinator
  npx @anthropic-community/browser-coordinator-mcp

  # Force Edge, with UI visible
  npx @anthropic-community/browser-coordinator-mcp --browser edge --no-headless

  # Wrap Playwright MCP with CDP endpoint injection
  npx @anthropic-community/browser-coordinator-mcp wrap -- \\
    npx -y @anthropic-ai/mcp-server-playwright --cdp-endpoint={cdp_endpoint}

MCP CONFIG (.mcp.json):
  {
    "mcpServers": {
      "browser": {
        "command": "npx",
        "args": ["-y", "@anthropic-community/browser-coordinator-mcp"]
      },
      "playwright": {
        "command": "npx",
        "args": [
          "-y", "@anthropic-community/browser-coordinator-mcp",
          "wrap", "--",
          "npx", "-y", "@anthropic-ai/mcp-server-playwright",
          "--cdp-endpoint={cdp_endpoint}"
        ]
      }
    }
  }

ENVIRONMENT:
  BROWSER_COORDINATOR_DEBUG=1  Enable debug logging to stderr
  VSCODE_CDP_PORT=<port>       VS Code CDP port (set by companion extension)
`);
}

async function runWrap(wrapArgs: { childCommand: string; childArgs: string[] }): Promise<void> {
  // Poll for state file with backoff (coordinator may still be starting)
  const maxWaitMs = 10000;
  const start = Date.now();
  let state = readState();

  while (!state && Date.now() - start < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 250));
    state = readState();
  }

  if (!state) {
    console.error("Error: could not read coordinator state file after 10s.");
    console.error("Make sure the browser-coordinator MCP server is running.");
    process.exit(1);
  }

  // Inject port into child args
  const childArgs = injectPort(wrapArgs.childArgs, state.port);

  // Spawn child with inherited stdio (transparent passthrough)
  const child = spawn(wrapArgs.childCommand, childArgs, {
    stdio: "inherit",
    env: process.env,
  });

  child.on("error", (err) => {
    console.error(`Error spawning child: ${err.message}`);
    process.exit(1);
  });

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });

  // Forward signals to child
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      child.kill(sig);
    });
  }
}

async function runServer(): Promise<void> {
  const opts = parseArgs();
  const coordinator = new CoordinatorServer(opts);

  // Initialize (start CDP proxy, detect VS Code — no browser yet)
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

async function main(): Promise<void> {
  const wrapArgs = parseWrapArgs();

  if (wrapArgs) {
    await runWrap(wrapArgs);
  } else {
    await runServer();
  }
}

main().catch((err) => {
  logError("Fatal error during startup", err);
  process.exit(1);
});
