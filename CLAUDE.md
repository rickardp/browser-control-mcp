# Browser Coordinator MCP

MCP server that manages browser lifecycle and provides a stable CDP proxy port. It acts as a browser controller for agent-driven development, while child MCPs (like Playwright MCP) are configured independently and connect to the coordinator's CDP proxy.

## Quick Context

- **Package:** `@anthropic-community/browser-coordinator-mcp`
- **Language:** TypeScript (ESM), compiled with `tsc`
- **Runtime:** Node.js >= 18
- **Single dependency:** `@modelcontextprotocol/sdk` ^1.12.0

## Key Principles

- **Zero config by default.** The server must work with just `npx @anthropic-community/browser-coordinator-mcp` — no flags required.
- **Controller + CDP proxy, not MCP proxy.** The coordinator manages browser lifecycle and provides a stable CDP port. It does not proxy MCP tool calls.
- **Two independent MCP entries.** The coordinator and child MCP are separate servers in `.mcp.json`. The `wrap` subcommand bridges them via a state file.
- **Lazy browser launch.** Browsers spawn on first CDP connection or explicit `coordinator_launch_browser` call, not at startup.
- **Stable CDP proxy port.** When the browser switches or restarts, the proxy port stays the same. Child MCPs never need restarting.

## Architecture

The coordinator exposes only `coordinator_*` tools. Child MCPs (e.g. Playwright MCP) are configured separately and connect to the coordinator's CDP reverse proxy.

```
Host → Coordinator MCP (coordinator_* tools)
     → Child MCP (browser_* tools, via wrap subcommand)
            ↓ CDP
     CDP Reverse Proxy (stable port, state file)
            ↓ CDP (internal port)
     Browser (Chrome/Edge/etc)
```

## Project Structure

```
cli.ts                     Entry point, arg parsing, wrap subcommand, stdio transport
coordinator-server.ts      Core MCP server, coordinator tools, CDP proxy integration
cdp-proxy.ts               TCP reverse proxy for CDP connections
state.ts                   State file management (proxy port discovery)
browser-launcher.ts        Port allocation, browser spawn, lifecycle
browser-detector.ts        Cross-platform browser detection
vscode-integration.ts      VS Code environment detection, CDP discovery
extension.ts               VS Code companion extension
```

Files are flat in the project root — no `src/` directory. Output compiles to `dist/`.

## Commands

```bash
bun run build    # Compile TypeScript (MCP + extension)
bun run dev      # Watch mode (MCP only)
bun start        # Run compiled server
```

## Blueprint Documentation

Architecture decisions and specifications are in `docs/`:

- `docs/adrs/` — Architecture Decision Records
  - [001-typescript](docs/adrs/001-typescript.md) — TypeScript as language
  - [002-mcp-sdk](docs/adrs/002-mcp-sdk.md) — MCP SDK as protocol framework
  - [003-cdp-browser-control](docs/adrs/003-cdp-browser-control.md) — CDP as browser control protocol
  - [004-proxy-architecture](docs/adrs/004-proxy-architecture.md) — ~~Proxy architecture for tool merging~~ (superseded by ADR-008)
  - [005-lazy-browser-launch](docs/adrs/005-lazy-browser-launch.md) — Lazy browser launch strategy
  - [006-two-tier-vscode-integration](docs/adrs/006-two-tier-vscode-integration.md) — Two-tier VS Code integration
  - [007-bun-package-manager](docs/adrs/007-bun-package-manager.md) — Bun as package manager
  - [008-cdp-reverse-proxy](docs/adrs/008-cdp-reverse-proxy.md) — CDP reverse proxy with two independent MCP entries
- `docs/specs/` — Specifications
  - [product](docs/specs/product.md) — Vision, users, success metrics
  - [tech-stack](docs/specs/tech-stack.md) — Runtime, dependencies, commands
  - [boundaries](docs/specs/boundaries.md) — Agent boundaries for this codebase
  - [features/browser-lifecycle](docs/specs/features/browser-lifecycle.md) — Browser management
  - [features/vscode-integration](docs/specs/features/vscode-integration.md) — VS Code companion extension
  - [features/cdp-proxy](docs/specs/features/cdp-proxy.md) — CDP reverse proxy and state file

## Boundaries (Quick Reference)

- Keep flat file structure (no `src/` directory)
- No bundler — `tsc` only
- No config files (YAML, TOML) — CLI flags and env vars only
- No database or persistence beyond the state file
- Don't send `tools/list_changed` — hosts don't reliably support it
- Don't proxy MCP tool calls — coordinator only exposes its own tools
- Supported browsers: Chrome, Edge, Chromium, Brave (Firefox aspirational)
