# Browser Coordinator MCP

An MCP server that owns the browser lifecycle so your downstream browser automation MCP doesn't have to. It sits between the MCP host (Claude Code, Claude Desktop) and a child MCP server like Playwright MCP, managing browser detection, launch, restart, and teardown — while the child MCP focuses purely on automation.

The browser launches lazily on the first tool call. Startup is instant.

## Why This Exists

Browser automation MCPs like `@anthropic-ai/mcp-server-playwright` have a coupling problem: they either manage their own browser (launching Chromium behind the scenes, giving you no control over which browser or profile is used) or they accept a `--cdp-endpoint` flag and expect you to handle the browser yourself.

Neither option works well for agent-driven development:

- **Agents can't manage processes.** Claude Code can invoke tools, but it can't spawn Chrome, parse a WebSocket URL from stderr, and pass it to another MCP server. That's infrastructure work.
- **MCP hosts don't coordinate.** If you configure both a browser launcher and Playwright MCP as separate servers, they can't talk to each other. The host treats them as independent.
- **`tools/list_changed` is broken.** Claude Code calls `tools/list` once at startup and ignores the `notifications/tools/list_changed` notification. Dynamic tool registration doesn't work — every tool must be available from the first message.

The coordinator solves this by acting as a single MCP server that pre-allocates a port, spawns the child MCP with that port as its `--cdp-endpoint`, and defers the actual browser launch until the agent invokes its first browser tool. From the host's perspective, all tools are available instantly. From the child MCP's perspective, the CDP endpoint is there when it needs it.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  MCP Host (Claude Code / Claude Desktop)                │
│                                                         │
│  Sees: coordinator_* tools + browser_* tools            │
│        (all available from first message)               │
│                                                         │
│    ↕ stdio                                              │
├─────────────────────────────────────────────────────────┤
│  Browser Coordinator MCP                                │
│                                                         │
│  ┌─────────────────┐  ┌───────────────────────────────┐ │
│  │ Coordinator      │  │ MCP Proxy                     │ │
│  │ Tools            │  │                               │ │
│  │                  │  │ Spawns child MCP as           │ │
│  │ list_browsers    │  │ subprocess, connects as       │ │
│  │ status           │  │ MCP client, fetches its       │ │
│  │ launch_browser   │  │ tool list, forwards calls     │ │
│  │ stop_browser     │  │                               │ │
│  │ restart_browser  │  │    ↕ stdio                    │ │
│  └─────────────────┘  └───────────────────────────────┘ │
│                                                         │
│  ┌─────────────────┐  ┌───────────────────────────────┐ │
│  │ Browser          │  │ VS Code Integration           │ │
│  │ Launcher         │  │                               │ │
│  │                  │  │ Tier 1: External Chrome       │ │
│  │ Port pre-alloc   │  │   + Simple Browser preview    │ │
│  │ Browser detect   │  │ Tier 2: VS Code's own CDP     │ │
│  │ Lazy launch      │  │   via companion extension     │ │
│  │ Process mgmt     │  │                               │ │
│  └─────────────────┘  └───────────────────────────────┘ │
│                                                         │
│    ↕ CDP (WebSocket on pre-allocated port)              │
├─────────────────────────────────────────────────────────┤
│  Child MCP (e.g. @anthropic-ai/mcp-server-playwright)   │
│                                                         │
│    ↕ CDP                                                │
├─────────────────────────────────────────────────────────┤
│  Browser (Chrome / Edge / Chromium / Brave)             │
└─────────────────────────────────────────────────────────┘
```

## How It Works

### The Lazy Launch Sequence

```
Startup (instant — no browser process):

  1. Pre-allocate a free TCP port         → e.g. 41837
  2. Spawn child MCP with                 → npx @playwright/mcp --cdp-endpoint=http://localhost:41837
  3. Child MCP starts, registers tools    → browser_navigate, browser_click, browser_snapshot, ...
  4. Coordinator merges tool lists         → coordinator_* + browser_*
  5. Host calls tools/list                → gets everything
  6. No browser is running.               → zero memory, zero CPU

First browser tool call (e.g. browser_navigate):

  7. Coordinator intercepts               → "browser not running yet"
  8. Launches Chrome on port 41837        → chrome --remote-debugging-port=41837 --headless=new
  9. Parses "DevTools listening on ws://..." from stderr
  10. Forwards the tool call to child MCP
  11. Child MCP lazily connects to CDP    → automation begins

Subsequent calls:

  12. Forwarded directly                  → no overhead
```

### Why This Works

Playwright MCP connects to its `--cdp-endpoint` **lazily** — on the first tool invocation, not at server startup. This was confirmed by examining the source: the extension README states "When the LLM interacts with the browser **for the first time**..." and issue reports show errors occurring "on the very first attempt to use the tool." The MCP server registers all tools immediately regardless of whether a browser is available.

This means we can safely hand it a port that nothing is listening on yet. By the time the first tool call arrives, the coordinator has launched the browser on that port, and the child MCP's lazy connection succeeds.

### Port Pre-Allocation

The coordinator uses the standard `net.createServer()` pattern to find a free port:

```typescript
const srv = net.createServer();
srv.listen(0, () => {
  const port = (srv.address() as AddressInfo).port;
  srv.close(() => resolve(port));
});
```

There is a theoretical race window between releasing the socket and Chrome binding to the port. In practice, this is the same pattern used by every test runner (Jest, Vitest, Playwright itself) and the window is negligible for local development. If another process claims the port, the browser launch fails and the coordinator returns an error — the agent can retry with `coordinator_restart_browser`.

### Tool Routing

When the host calls a tool:

1. **Name starts with `coordinator_`** → handled directly by the coordinator (browser management)
2. **Name exists in child MCP's tool list** → `ensureBrowserRunning()`, then forwarded to child via the MCP proxy
3. **Unknown** → error response

The coordinator never modifies tool arguments or responses. It's a transparent proxy with a lazy-launch interceptor.

## VS Code Integration

When running inside VS Code's integrated terminal, the coordinator detects the environment and adapts its behavior.

| | Tier 1 — External Browser | Tier 2 — Native CDP |
|---|---|---|
| **Requires** | Nothing | Companion VS Code extension |
| **Browser** | External Chrome/Edge (headed or headless) | VS Code's own Electron/Chromium |
| **Preview** | Simple Browser shows the same URL (best-effort, not synced with DOM mutations) | Automation happens directly inside VS Code |
| **Setup** | Zero config | One-time: extension enables `--remote-debugging-port` in `argv.json`, VS Code restart |

### How Tier Detection Works

```
Is TERM_PROGRAM=vscode or VSCODE_PID set?
  │
  ├─ No  → External mode (same as non-VS Code)
  │
  └─ Yes → Check for CDP port:
           │
           ├─ VSCODE_CDP_PORT env var set?                    → Tier 2
           ├─ Port file at $TMPDIR/vscode-cdp-port?           → Tier 2
           ├─ Parent process has --remote-debugging-port arg?  → Tier 2
           │
           └─ None found → Tier 1 (external browser)
```

### Tier 2: Companion Extension

The companion extension (`vscode-extension/`) handles the one thing a regular MCP server cannot do: modify VS Code's startup flags.

1. On activation, checks `~/.vscode/argv.json` for `"remote-debugging-port"`
2. If missing, prompts the user to enable it (writes `"remote-debugging-port": 0`)
3. After VS Code restarts, discovers the actual port (OS-assigned since we used port 0)
4. Writes the port to `$TMPDIR/vscode-cdp-port` and sets `VSCODE_CDP_PORT` in the environment
5. The coordinator picks this up automatically on next launch

With Tier 2, there is no external browser process. The agent automates VS Code's own Simple Browser webview via CDP, and the user watches it happen in their editor.

### Marketplace Research

Before building the companion extension, the VS Code marketplace was surveyed for existing solutions:

- **Microsoft Edge Tools for VS Code** — Launches a real external Chrome/Edge process and streams its viewport into VS Code via CDP screencasting. Closest in spirit, but doesn't expose VS Code's own CDP port for external tool access.
- **Browser Preview** (deprecated) — Launched headless Chromium inside a webview. Deprecated in favor of Live Preview. Used CDP internally but didn't expose the endpoint for external automation.
- **Live Preview** — Microsoft's replacement for Browser Preview. Serves static files with hot reload in an embedded browser. No CDP exposure, no external automation support.

No existing extension provides the specific capability needed: auto-configuring `argv.json` to enable `--remote-debugging-port` and exposing the discovered port for external tools. That's what the companion extension does.

## Quick Start

### Claude Code

```json
// .mcp.json (project-level) or ~/.claude/mcp.json (global)
{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": ["-y", "@anthropic-community/browser-coordinator-mcp"]
    }
  }
}
```

### Claude Desktop

```json
// claude_desktop_config.json
{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": ["-y", "@anthropic-community/browser-coordinator-mcp"]
    }
  }
}
```

### With Options

```json
{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": [
        "-y", "@anthropic-community/browser-coordinator-mcp",
        "--browser", "edge",
        "--no-headless"
      ]
    }
  }
}
```

### Custom Child MCP

```json
{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": [
        "-y", "@anthropic-community/browser-coordinator-mcp",
        "--mcp", "@anthropic-ai/mcp-server-playwright@latest"
      ]
    }
  }
}
```

The agent never needs to call `coordinator_launch_browser` for the default case. The moment it calls `browser_navigate("http://localhost:3000")`, the browser appears.

## Integrating with MCP Servers

The coordinator eliminates the static configuration problem that browser automation MCP servers have. Without the coordinator, you must either:

- Let the MCP server launch its own bundled Chromium (no control over browser, profile, or lifecycle)
- Pass a static `--cdp-endpoint` flag and manually manage a browser process

The coordinator handles both: it pre-allocates a port, passes it to the child MCP, and launches the real browser lazily on demand.

### Playwright MCP (default)

The coordinator uses [`@anthropic-ai/mcp-server-playwright`](https://github.com/anthropics/anthropic-ai-mcp-server-playwright) by default. No extra configuration needed — the coordinator spawns it as a subprocess and injects `--cdp-endpoint` automatically.

**Claude Code** (`.mcp.json`):
```json
{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": ["-y", "@anthropic-community/browser-coordinator-mcp"]
    }
  }
}
```

**Claude Desktop** (`claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": ["-y", "@anthropic-community/browser-coordinator-mcp"]
    }
  }
}
```

**Without the coordinator**, you'd have to configure Playwright MCP directly and either accept its bundled Chromium or manually start a browser and hardcode the port:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@anthropic-ai/mcp-server-playwright"]
    }
  }
}
```

This launches Playwright's own Chromium with no browser choice, no lifecycle control, and no way to restart or switch browsers mid-session.

### Browserbase MCP

[Browserbase](https://github.com/nichochar/mcp-server-browserbase) provides cloud-hosted browsers. You can use it as the child MCP instead of Playwright:

```json
{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": [
        "-y", "@anthropic-community/browser-coordinator-mcp",
        "--mcp", "@nichochar/mcp-server-browserbase"
      ],
      "env": {
        "BROWSERBASE_API_KEY": "your-api-key",
        "BROWSERBASE_PROJECT_ID": "your-project-id"
      }
    }
  }
}
```

### Puppeteer MCP

The [Puppeteer MCP server](https://github.com/anthropics/anthropic-quickstarts/tree/main/mcp-server-puppeteer) can also be used as a child MCP:

```json
{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": [
        "-y", "@anthropic-community/browser-coordinator-mcp",
        "--mcp", "@anthropic-ai/mcp-server-puppeteer"
      ]
    }
  }
}
```

### Any CDP-Compatible MCP Server

Any MCP server that accepts a `--cdp-endpoint` flag works as a child. The coordinator automatically appends `--cdp-endpoint=http://localhost:<port>` to the child's arguments:

```json
{
  "mcpServers": {
    "browser": {
      "command": "npx",
      "args": [
        "-y", "@anthropic-community/browser-coordinator-mcp",
        "--mcp", "your-custom-mcp-server"
      ]
    }
  }
}
```

Everything after `--mcp` is forwarded as the child MCP command. The coordinator adds `--cdp-endpoint` unless it's already present in the args.

### What the Coordinator Adds

Without the coordinator, each of these MCP servers requires you to either accept their defaults or manually manage browser processes. With the coordinator:

| Problem | Without Coordinator | With Coordinator |
|---------|-------------------|-----------------|
| **Browser choice** | Uses bundled Chromium (or none) | Auto-detects Chrome, Edge, Chromium, Brave |
| **Lifecycle** | Browser starts at MCP init (or never) | Lazy launch on first tool call |
| **Restart** | Kill and restart the entire MCP server | `coordinator_restart_browser` keeps the session |
| **Switch browser** | Change config and restart | `coordinator_launch_browser` with `browserType` |
| **Port management** | Hardcode a port or let MCP pick | Dynamic port pre-allocation |
| **VS Code** | No special support | Auto-detects environment, enables preview |

## Tools

### Coordinator Tools

| Tool | Description |
|------|------------|
| `coordinator_list_browsers` | Scan the system for CDP-capable browsers (Chrome, Edge, Chromium, Brave) and report their paths and versions |
| `coordinator_status` | Current state: which browser is running, CDP port, VS Code tier, child MCP connection status |
| `coordinator_launch_browser` | Explicitly launch or relaunch with specific options (browser type, headless toggle). Useful for switching browsers mid-session. |
| `coordinator_stop_browser` | Stop the running browser process |
| `coordinator_restart_browser` | Kill and relaunch the browser on the same port. The child MCP reconnects automatically. |

### Proxied Tools

All tools from the downstream child MCP are exposed transparently. With `@anthropic-ai/mcp-server-playwright`, this includes:

- `browser_navigate` — Go to a URL
- `browser_snapshot` — Capture an accessibility tree snapshot
- `browser_click` — Click an element by accessibility reference
- `browser_type` — Type text into a focused element
- `browser_screenshot` — Take a PNG screenshot
- `browser_hover`, `browser_select_option`, `browser_press_key`, ...

The coordinator does not modify these tools' schemas, arguments, or responses. It only intercepts the call to ensure a browser is running before forwarding.

## CLI Reference

```
browser-coordinator-mcp — MCP server for browser lifecycle coordination

USAGE:
  npx @anthropic-community/browser-coordinator-mcp [options]

OPTIONS:
  --mcp <package>       Child MCP server to proxy
                        Default: @anthropic-ai/mcp-server-playwright
                        Example: --mcp @anthropic-ai/mcp-server-playwright@latest

  --browser <type>      Preferred browser: chrome, edge, chromium, brave
                        Default: auto-detect (first available)

  --browser-path <path> Explicit path to browser executable
                        Overrides --browser detection

  --no-headless         Launch browser with visible UI
                        Default: headless

  --no-vscode           Skip VS Code environment detection
                        Forces external browser mode even inside VS Code

  --help, -h            Show help
```

## Environment Variables

| Variable | Description |
|----------|------------|
| `BROWSER_COORDINATOR_DEBUG=1` | Enable debug logging to stderr. Logs port allocation, browser launch, child MCP communication. |
| `VSCODE_CDP_PORT=<port>` | VS Code's CDP port. Set by the companion extension. The coordinator uses this to skip launching an external browser (Tier 2). |

## Project Structure

```
browser-coordinator-mcp/
├── src/
│   ├── cli.ts                  Entry point. Parses args, wires up stdio transport, handles shutdown.
│   ├── coordinator-server.ts   Core MCP server. Tool merging, lazy-launch interceptor, tool routing.
│   ├── mcp-proxy.ts            Spawns child MCP as subprocess, connects as MCP client, proxies calls.
│   ├── browser-launcher.ts     Port pre-allocation, browser spawn, stderr parsing, process lifecycle.
│   ├── browser-detector.ts     Cross-platform browser path scanning (macOS, Linux, Windows).
│   ├── vscode-integration.ts   VS Code env detection, CDP port discovery, webview target finder.
│   ├── log.ts                  Debug logging to stderr, gated by BROWSER_COORDINATOR_DEBUG.
│   └── index.ts                Library barrel exports.
├── vscode-extension/
│   ├── src/extension.ts        Companion extension for Tier 2 (argv.json, port discovery, status bar).
│   ├── package.json            Extension manifest with commands and activation events.
│   └── tsconfig.json
├── package.json
├── tsconfig.json
└── README.md
```

## Design Decisions

### Why a proxy instead of a standalone MCP?

The coordinator doesn't implement browser automation itself. It proxies an existing MCP server (Playwright MCP by default). This means:

- **No duplication.** Playwright MCP already has excellent tool implementations. Reimplementing `browser_click` would be pointless.
- **Swappable.** You can use any child MCP that accepts `--cdp-endpoint` — Playwright MCP, a custom DevTools MCP, or anything else that speaks CDP.
- **Separation of concerns.** The coordinator owns the browser process. The child MCP owns the automation protocol. Neither needs to know about the other's internals.

### Why lazy launch instead of eager?

The original design launched the browser during MCP initialization. This worked but had drawbacks:

- A browser process starts even if the agent never uses browser tools in that session.
- MCP startup takes 2–3 seconds instead of being instant.
- In CI environments, this wastes resources.

Lazy launch was made possible by a key finding: Playwright MCP connects to its CDP endpoint lazily, not at startup. It registers all tools immediately and only attempts the WebSocket connection on the first tool call. This means we can hand it a port that nothing is listening on yet. By the time the first tool call arrives, the coordinator has launched the browser on that port, and the child MCP's lazy connection succeeds.

### Why pre-allocate the port?

The child MCP needs `--cdp-endpoint=http://localhost:<port>` at spawn time. But if we launch Chrome with `--remote-debugging-port=0`, it picks a random port — and we can't know it until the process starts and prints to stderr. Pre-allocating a specific port lets us tell the child MCP where to connect before the browser exists.

The alternative — using port 0 and parsing the actual port from stderr — would require launching the browser before the child MCP, which defeats lazy launch.

### Why not `tools/list_changed`?

The MCP spec defines `notifications/tools/list_changed` for dynamic tool registration. In theory, the coordinator could start with only `coordinator_*` tools, then emit a notification after the child MCP connects and adds `browser_*` tools.

In practice, Claude Code ignores this notification. It calls `tools/list` once at startup and never refreshes. This is a known issue, confirmed by multiple developers and documented in community discussions. The coordinator works around it by having all tools — both its own and the child MCP's — available from the first `tools/list` response.

### Why two VS Code tiers?

Tier 1 (external browser) requires zero configuration and works everywhere. But it means the agent controls a browser the developer can't see in their editor without extra setup.

Tier 2 (native CDP) eliminates the external browser entirely — automation happens inside VS Code's own Chromium process. The tradeoff is a one-time setup: installing the companion extension and restarting VS Code. Both tiers are supported because forcing extension installation as a prerequisite would be a poor default experience.

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

Load the extension in VS Code via "Developer: Install Extension from Location..." pointing to the `vscode-extension/` directory.

## License

MIT
