# Feature: MCP Proxy

## Overview

The coordinator acts as an MCP proxy — it spawns a child MCP server as a subprocess, connects to it as an MCP client, and merges both tool sets into a single unified interface for the host. This enables seamless integration of browser lifecycle tools with browser automation tools.

## Child MCP Management (`mcp-proxy.ts`)

### Spawning

The child MCP is spawned as a subprocess using `child_process.spawn` with stdio transport:

- **stdin/stdout:** MCP protocol (JSON-RPC)
- **stderr:** Inherited (child's logs appear in coordinator's stderr)

**Default child:** `@anthropic-ai/mcp-server-playwright`
**Override:** `--mcp <package>` CLI flag

The child receives the pre-allocated CDP port via its arguments (e.g., `--cdp-endpoint=http://localhost:<port>`).

### Connection

After spawning, the coordinator connects to the child as an MCP client using the SDK's `Client` class and stdio transport. This triggers:

1. MCP protocol handshake (version negotiation)
2. Capability exchange
3. Tool list fetch (cached for the session)

### API

| Method | Description |
|--------|-------------|
| `connect()` | Spawn child process and establish MCP client connection |
| `refreshTools()` | Fetch and cache child's tool list |
| `getTools()` | Return cached child tools |
| `hasTool(name)` | Check if child provides a specific tool |
| `callTool(name, args)` | Forward a tool call to child and return result |
| `disconnect()` | Kill child process and close MCP transport |

## Tool Merging (`coordinator-server.ts`)

### `tools/list` Response

When the host requests `tools/list`, the coordinator returns a merged list:

```
[
  ...coordinatorTools,    // coordinator_list_browsers, coordinator_status, etc.
  ...childMcpTools        // browser_navigate, browser_click, browser_screenshot, etc.
]
```

All tools are available from the first `tools/list` response. The coordinator does not send `tools/list_changed` notifications because hosts (specifically Claude Code) don't reliably support them.

### Tool Call Routing

```
tools/call received
  │
  ├─ name starts with "coordinator_"?
  │   └─ Yes → handleCoordinatorTool(name, args)
  │
  ├─ childProxy.hasTool(name)?
  │   └─ Yes → ensureBrowserRunning() → childProxy.callTool(name, args)
  │
  └─ Neither → return error: "Unknown tool"
```

### Lazy Browser Trigger

The `ensureBrowserRunning()` check before child tool calls is the mechanism that triggers lazy browser launch. On first call:

1. Browser is launched on the pre-allocated port
2. CDP readiness is confirmed
3. The tool call is forwarded to the child
4. The child connects to CDP on its first tool execution

On subsequent calls, the browser is already running and the call is forwarded immediately.

## Error Handling

- **Child spawn failure:** Coordinator reports error on `tools/list` — no tools available from child
- **Child tool call failure:** Error response is forwarded transparently to host
- **Child process crash:** Detected via process exit event; subsequent tool calls will fail with descriptive error
- **Browser launch failure:** Error returned for the triggering tool call; subsequent calls will retry launch

## Lifecycle

```
Coordinator start:
  1. Pre-allocate CDP port
  2. Spawn child MCP subprocess
  3. Connect as MCP client
  4. Fetch and cache child tools
  5. Ready to serve tools/list

During operation:
  - Coordinator tools: handled directly
  - Child tools: ensure browser → forward → return result

Coordinator shutdown:
  1. Stop browser (if running)
  2. Disconnect from child MCP
  3. Kill child subprocess
  4. Clean up temp directories
```
