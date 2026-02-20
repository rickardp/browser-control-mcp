# Browser Coordinator MCP

**Give your AI agent a real browser it can control.**

Browser Coordinator MCP manages browser lifecycle and exposes a stable CDP port so any browser automation MCP (like Playwright MCP) can connect — without hardcoded ports, manual browser launches, or restarts when you switch browsers.

Supports **Chrome, Edge, Chromium, Brave** (via CDP) and **Firefox** (via WebDriver BiDi). No browser downloads — uses whatever you already have installed.

## Integration

Add both entries to your `.mcp.json` (Claude Code) or MCP client config:

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
        "npx", "-y", "@playwright/mcp@latest",
        "--cdp-endpoint={cdp_endpoint}"
      ]
    }
  }
}
```

That's it. The coordinator launches a browser on demand, and Playwright MCP connects to it through a stable CDP proxy. No flags required.

Works with any CDP-capable child MCP — see [docs/compatibility.md](docs/compatibility.md) for the full list including Chrome DevTools MCP, Selenium, Firefox DevTools, and more.

### Options

Pick a specific browser or show the UI:

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
        "npx", "-y", "@playwright/mcp@latest",
        "--cdp-endpoint={cdp_endpoint}"
      ]
    }
  }
}
```

### Chrome DevTools MCP

Google's Chrome DevTools MCP also connects through the coordinator:

```json
{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": ["-y", "@anthropic-community/browser-coordinator-mcp"]
    },
    "chrome-devtools": {
      "command": "npx",
      "args": [
        "-y", "@anthropic-community/browser-coordinator-mcp",
        "wrap", "--",
        "npx", "-y", "chrome-devtools-mcp@latest",
        "--browser-url={cdp_endpoint}"
      ]
    }
  }
}
```

### Firefox

Use Firefox instead of Chromium. The coordinator connects via WebDriver BiDi (Firefox 129+):

```json
{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": [
        "-y", "@anthropic-community/browser-coordinator-mcp",
        "--browser", "firefox"
      ]
    }
  }
}
```

All `coordinator_*` tools work with Firefox. Note: child MCPs like Playwright MCP require CDP and won't work through the proxy when Firefox is active — use the coordinator's own tools instead, or switch back to a Chromium browser.

### Custom child MCP

Any CDP-based MCP server works. Use `wrap` to inject the proxy port into child args:

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

Template variables: `{cdp_endpoint}` becomes `http://localhost:<port>`, `{cdp_port}` becomes just the port number.

## How It Works

The coordinator and child MCP are **two independent MCP servers**. The host sees both sets of tools separately.

```
Host (Claude Code / Claude Desktop)
  ├── Coordinator MCP ─── coordinator_* tools
  │       │
  │       ├── CDP ──→ Chromium (Chrome / Edge / Chromium / Brave)
  │       └── BiDi ─→ Firefox  (--browser firefox)
  │
  │   CDP Reverse Proxy (stable port, Chromium only)
  │       ▲
  │       │ CDP
  └── Child MCP (Playwright) ─── browser_* tools
```

The key idea: a **CDP reverse proxy** sits between the child MCP and the browser. The proxy listens on a fixed port. When you switch browsers or restart, the proxy reconnects internally — the child MCP never needs restarting.

The browser launches **lazily**: either when a CDP connection hits the proxy, or when you explicitly call `coordinator_launch_browser`.

The `wrap` subcommand bridges the two servers — it reads a state file to discover the proxy port, injects it into the child MCP's args, then spawns the child with stdio passthrough.

## Tools

| Tool | Description |
|------|-------------|
| `coordinator_list_browsers` | Scan the system for installed browsers (CDP + BiDi) |
| `coordinator_status` | Show running browser, engine, proxy port, VS Code tier |
| `coordinator_launch_browser` | Launch or relaunch — accepts `chrome`, `edge`, `chromium`, `brave`, `firefox` |
| `coordinator_stop_browser` | Stop the running browser |
| `coordinator_restart_browser` | Kill and relaunch — proxy port stays the same |
| `coordinator_navigate` | Navigate to a URL (VS Code Simple Browser, CDP, or BiDi) |
| `coordinator_select_element` | Interactive element picker — returns tag, selector, bounding box |
| `coordinator_get_dom` | Get rendered DOM as HTML, with shadow DOM flattened |
| `coordinator_get_markdown` | Get page content as clean Markdown (via Turndown.js) |
| `coordinator_screenshot` | Capture screenshot (full page, element, or clip rect) |
| `coordinator_fetch` | HTTP request through the browser's network stack (cookies, no CORS) |

## CLI Reference

```
USAGE:
  npx @anthropic-community/browser-coordinator-mcp [options]
  npx @anthropic-community/browser-coordinator-mcp wrap -- <command> [args...]

MODES:
  (default)   Start the coordinator MCP server
  wrap        Read coordinator state, inject CDP port into child command, run it

OPTIONS:
  --browser <type>      Preferred browser: chrome, edge, chromium, brave, firefox
                        Default: auto-detect (first Chromium found)
  --browser-path <path> Explicit path to browser executable
  --no-headless         Launch browser with visible UI (default: headless)
  --no-vscode           Skip VS Code detection, force external browser
  --help, -h            Show help
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `BROWSER_COORDINATOR_DEBUG=1` | Enable debug logging to stderr |
| `VSCODE_CDP_PORT=<port>` | VS Code's CDP port (set by companion extension for Tier 2 integration) |

## VS Code Integration

Inside VS Code's integrated terminal, the coordinator detects the environment automatically.

| | Tier 1 — External Browser | Tier 2 — Native CDP |
|---|---|---|
| **Requires** | Nothing | Companion VS Code extension |
| **Browser** | External Chrome/Edge | VS Code's own Chromium |
| **Setup** | Zero config | One-time: extension enables `--remote-debugging-port`, then restart VS Code |

## Browser Detection

The coordinator scans platform-specific paths for Chrome, Edge, Chromium, Brave, and Firefox:

| Platform | Search locations |
|----------|-----------------|
| **macOS** | `/Applications/*.app` |
| **Linux** | `/usr/bin/*`, `which` fallback |
| **Windows** | `C:\Program Files\...`, registry-standard paths |

Override with `--browser <type>` or `--browser-path <path>`.

## Development

```bash
git clone https://github.com/anthropics/browser-coordinator-mcp.git
cd browser-coordinator-mcp
bun install
bun run build
```

```bash
# Run with debug logging
BROWSER_COORDINATOR_DEBUG=1 node dist/cli.js --no-headless

# Run tests
bun test
```

## License

MIT
