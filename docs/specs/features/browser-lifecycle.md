# Feature: Browser Lifecycle Management

## Overview

The coordinator manages the full lifecycle of a browser process: detection, port allocation, launch, health monitoring, restart, and cleanup. This is the core capability that enables child MCPs to focus purely on automation.

## Components

### Browser Detection (`browser-detector.ts`)

Scans the system for installed Chromium-based browsers.

**Supported browsers (in preference order):**
1. Chrome
2. Edge
3. Chromium
4. Brave

**Platform-specific detection:**

| Platform | Method |
|----------|--------|
| macOS | Check `/Applications/*.app/Contents/MacOS/*` paths |
| Linux | Check `/usr/bin/*` paths, fallback to `which` |
| Windows | Check `Program Files` paths via environment variables |

**API:**
- `detectBrowsers()` — returns all installed browsers with name, type, and path
- `findBrowser(preferredType?)` — returns first available browser, respecting optional preference

### Port Allocation (`browser-launcher.ts`)

Pre-allocates a free TCP port for CDP before launching the browser.

**Method:** Bind a temporary TCP server to port 0 (OS assigns a free port), record the port, close the server immediately. This is the same pattern used by Jest, Vitest, and Playwright.

**API:**
- `getFreePort()` — returns a free port number

### Browser Launch (`browser-launcher.ts`)

Spawns a browser process with CDP enabled on the pre-allocated port.

**Browser flags:**
```
--remote-debugging-port=<port>
--user-data-dir=<tmpdir>
--no-first-run
--no-default-browser-check
--disable-background-networking
--disable-default-apps
--disable-extensions
--disable-sync
--disable-translate
--metrics-recording-only
--mute-audio
--headless=new            (unless --no-headless)
about:blank               (initial page)
```

**Temporary profile:** Each launch creates an isolated user data directory in `$TMPDIR` to avoid interfering with the user's real browser profile.

**Readiness detection:** The CDP WebSocket URL is parsed from browser stderr output. The coordinator also waits for the CDP port to accept TCP connections (polling every 100ms, 15-second timeout).

**API:**
- `launchBrowser(port, options)` — returns `BrowserInstance` with process handle, port, WebSocket URL, and temp directory path
- `waitForPort(port, timeoutMs)` — waits for CDP port to accept connections

### Browser Shutdown (`browser-launcher.ts`)

Graceful two-phase shutdown:

1. Send `SIGTERM` to browser process
2. Wait up to 5 seconds for exit
3. If still alive, send `SIGKILL`
4. Delete temporary user data directory

**API:**
- `stopBrowser(instance)` — gracefully stops and cleans up

## Coordinator Tools

These tools are exposed to the AI host for direct browser management:

| Tool | Description | Requires Browser |
|------|-------------|-----------------|
| `coordinator_list_browsers` | List installed CDP-capable browsers | No |
| `coordinator_status` | Show current state (browser, port, tier, child) | No |
| `coordinator_launch_browser` | Explicitly launch or relaunch with options | Creates one |
| `coordinator_stop_browser` | Stop running browser | Yes |
| `coordinator_restart_browser` | Kill and relaunch on same port | Yes |

## Lazy Launch Flow

```
Startup:
  1. getFreePort() → e.g., 41837
  2. Spawn child MCP with --cdp-endpoint=http://localhost:41837
  3. Child registers all tools (no browser needed yet)

First child tool call (e.g., browser_navigate):
  4. ensureBrowserRunning() triggers
  5. launchBrowser(41837, opts) spawns Chrome
  6. waitForPort(41837) confirms CDP ready
  7. Forward tool call to child MCP
  8. Child connects to CDP lazily and executes
```
