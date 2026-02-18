# Browser Coordinator MCP

An MCP server that manages browser lifecycle for agent-driven development. It launches, switches, and restarts browsers on demand — exposing a stable CDP proxy port that any downstream browser automation MCP (like Playwright MCP) can connect to independently.

The browser launches lazily — either when a CDP connection arrives at the proxy or when the agent explicitly calls `coordinator_launch_browser`. Startup is instant.

## Why This Exists

Browser automation MCPs like `@anthropic-ai/mcp-server-playwright` have a coupling problem: they either manage their own browser (launching Chromium behind the scenes, giving you no control over which browser or profile is used) or they accept a `--cdp-endpoint` flag and expect you to handle the browser yourself.

Neither option works well for agent-driven development:

- **Agents can't manage processes.** Claude Code can invoke tools, but it can't spawn Chrome, parse a WebSocket URL from stderr, and pass it to another MCP server.
- **No browser switching.** Once a browser is launched, there's no way to switch from Chrome to Edge or toggle headless mode without restarting everything.
- **Port coupling.** If you hardcode a CDP port, changing it requires restarting all connected MCPs.

The coordinator solves this by running a **CDP reverse proxy** on a stable port. The browser's internal port can change (when switching browsers or restarting), but the proxy port stays the same. Child MCPs connect to the proxy and never need restarting.

## Architecture

```
┌────────────────────────────────────────────────────────┐
│  MCP Host (Claude Code / Claude Desktop)               │
│                                                        │
│  MCP Server 1: browser-coordinator                     │
│    coordinator_list_browsers                           │
│    coordinator_status                                  │
│    coordinator_launch_browser                          │
│    coordinator_stop_browser                            │
│    coordinator_restart_browser                         │
│                                                        │
│  MCP Server 2: playwright (or any CDP-based MCP)       │
│    browser_navigate, browser_click, browser_snapshot.. │
└──────────┬──────────────────────────────────┬──────────┘
           │ control                          │ MCP protocol (stdio)
           ▼                                  ▼
┌─────────────────────┐            ┌────────────────────┐
│ Coordinator MCP     │            │ Child MCP          │
│                     │            │ (e.g. Playwright)  │
│ - Manages browser   │            │                    │
│ - Runs CDP proxy    │            │ Connects to CDP    │
│ - Writes state file │            │ at proxy port      │
│                     │            │                    │
└────────┬────────────┘            └─────────┬──────────┘
         │                                   │
         │ owns                              │ CDP via proxy
         ▼                                   │
┌─────────────────────┐                      │
│ CDP Reverse Proxy   │◄────────────────────-┘
│ (TCP, stable port)  │
│                     │
│ Launch triggers:    │
│  1. CDP connection  │
│     (lazy)          │
│  2. coordinator_    │
│     launch_browser  │
│     (explicit)      │
└────────┬────────────┘
         │ CDP (internal port)
         ▼
┌─────────────────────┐
│ Browser             │
│ (Chrome/Edge/etc)   │
└─────────────────────┘
```

## How It Works

### Two Independent MCP Servers

The coordinator and the child MCP (e.g. Playwright) are configured as **separate MCP servers** in `.mcp.json`. They don't proxy each other's tools — the host sees them independently.

The `wrap` subcommand bridges them: it reads the coordinator's state file to discover the CDP proxy port, injects it into the child MCP's command-line args, then spawns the child with stdio passthrough.

### CDP Reverse Proxy

The coordinator runs a TCP reverse proxy that:

1. Listens on a **stable port** (written to a state file)
2. Forwards connections to the browser's **internal CDP port**
3. Supports two launch triggers:
   - **Lazy:** When a CDP connection arrives and no browser is running, the proxy automatically launches one
   - **Explicit:** When the agent calls `coordinator_launch_browser`

When the user switches browsers (Chrome → Edge):
1. Old browser is killed
2. New browser launches on a new internal port
3. Proxy updates its backend target
4. Existing connections break (child MCP reconnects on next tool call)
5. **Proxy port stays the same** — no child MCP restart needed

### State File

The coordinator writes its proxy port and PID to:
```
$TMPDIR/browser-coordinator/state.json
→ { "port": 41837, "pid": 12345 }
```

The `wrap` subcommand reads this file (polling with backoff for up to 10s) to inject the port into child MCP arguments.

### The `wrap` Subcommand

```
npx @anthropic-community/browser-coordinator-mcp wrap -- <command> [args...]
```

Template variables in args:
- `{cdp_port}` → replaced with the proxy port number (e.g. `41837`)
- `{cdp_endpoint}` → replaced with `http://localhost:<port>`

The child process inherits stdio, making it transparent to the MCP host.

## Quick Start

### Claude Code / Claude Desktop

```json
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
```

### With Coordinator Options

```json
{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": [
        "-y", "@anthropic-community/browser-coordinator-mcp",
        "--browser", "edge", "--no-headless"
      ]
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
```

### Custom Child MCP

Any CDP-based MCP server works:

```json
{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": ["-y", "@anthropic-community/browser-coordinator-mcp"]
    },
    "my-automation": {
      "command": "npx",
      "args": [
        "-y", "@anthropic-community/browser-coordinator-mcp",
        "wrap", "--",
        "node", "./my-mcp.js", "--port={cdp_port}"
      ]
    }
  }
}
```

## VS Code Integration

When running inside VS Code's integrated terminal, the coordinator detects the environment and adapts its behavior.

| | Tier 1 — External Browser | Tier 2 — Native CDP |
|---|---|---|
| **Requires** | Nothing | Companion VS Code extension |
| **Browser** | External Chrome/Edge (headed or headless) | VS Code's own Electron/Chromium |
| **Setup** | Zero config | One-time: extension enables `--remote-debugging-port` in `argv.json`, VS Code restart |

## Tools

### Coordinator Tools

| Tool | Description |
|------|------------|
| `coordinator_list_browsers` | Scan the system for CDP-capable browsers (Chrome, Edge, Chromium, Brave) and report their paths |
| `coordinator_status` | Current state: which browser is running, CDP proxy port, VS Code tier |
| `coordinator_launch_browser` | Explicitly launch or relaunch with specific options (browser type, headless toggle). Useful for switching browsers mid-session. |
| `coordinator_stop_browser` | Stop the running browser process |
| `coordinator_restart_browser` | Kill and relaunch the browser. The CDP proxy port stays the same — child MCPs reconnect automatically. |

## CLI Reference

```
browser-coordinator-mcp — MCP server for browser lifecycle coordination

USAGE:
  npx @anthropic-community/browser-coordinator-mcp [options]
  npx @anthropic-community/browser-coordinator-mcp wrap -- <command> [args...]

MODES:
  (default)   Start the coordinator MCP server
  wrap        Read coordinator state, inject CDP port into child command, run it

OPTIONS:
  --browser <type>      Preferred browser: chrome, edge, chromium, brave
                        Default: auto-detect (first available)

  --browser-path <path> Explicit path to browser executable
                        Overrides --browser detection

  --no-headless         Launch browser with visible UI
                        Default: headless

  --no-vscode           Skip VS Code environment detection
                        Forces external browser mode even inside VS Code

  --help, -h            Show help

WRAP TEMPLATE VARIABLES:
  {cdp_port}            Replaced with the CDP proxy port number
  {cdp_endpoint}        Replaced with http://localhost:<port>
```

## Environment Variables

| Variable | Description |
|----------|------------|
| `BROWSER_COORDINATOR_DEBUG=1` | Enable debug logging to stderr. Logs port allocation, browser launch, CDP proxy activity. |
| `VSCODE_CDP_PORT=<port>` | VS Code's CDP port. Set by the companion extension. The coordinator uses this to skip launching an external browser (Tier 2). |

## Browser Detection

The coordinator scans platform-specific paths to find installed browsers:

| Platform | Paths scanned |
|----------|--------------|
| **macOS** | `/Applications/Google Chrome.app/...`, `/Applications/Microsoft Edge.app/...`, `/Applications/Chromium.app/...`, `/Applications/Brave Browser.app/...` |
| **Linux** | `/usr/bin/google-chrome-stable`, `/usr/bin/microsoft-edge`, `/usr/bin/chromium-browser`, `/usr/bin/brave-browser`, + `which` fallback |
| **Windows** | `C:\Program Files\Google\Chrome\...`, `C:\Program Files (x86)\Microsoft\Edge\...`, + registry-standard paths |

The first available browser is used by default. Override with `--browser <type>` or `--browser-path <path>`.

## Development

```bash
git clone <repo-url>
cd browser-coordinator-mcp
bun install
bun run build
```

### Testing locally

```bash
# Run directly with debug logging
BROWSER_COORDINATOR_DEBUG=1 node dist/cli.js --no-headless

# Or with npx from the project directory
npx . --browser chrome --no-headless
```

### Building the VS Code extension

```bash
cd vscode-extension
bun install
bun run build
```

## License

MIT
