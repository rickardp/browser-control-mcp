# Browser Coordinator MCP

MCP server that coordinates browser lifecycle and proxies browser automation tools. It acts as an intermediary between MCP hosts (Claude Code, Claude Desktop) and browser automation MCPs (like Playwright MCP).

## Quick Context

- **Package:** `@anthropic-community/browser-coordinator-mcp`
- **Language:** TypeScript (ESM), compiled with `tsc`
- **Runtime:** Node.js >= 18
- **Single dependency:** `@modelcontextprotocol/sdk` ^1.12.0

## Key Principles

- **Zero config by default.** The server must work with just `npx @anthropic-community/browser-coordinator-mcp` — no flags required.
- **Proxy, not reimplementation.** The coordinator manages browser lifecycle and forwards tool calls. It never duplicates automation logic from the child MCP.
- **Lazy browser launch.** Browsers spawn on first tool call, not at startup.
- **Purpose-driven browser selection.** The agent states what it needs; the coordinator picks the best browser/configuration.

## Architecture

The coordinator plays two MCP roles simultaneously:
1. **MCP Server** — exposes tools to the host (Claude Code)
2. **MCP Client** — connects to a child MCP subprocess (Playwright MCP)

Tool routing: `coordinator_*` tools are handled directly; all others are forwarded to the child MCP.

## Project Structure

```
cli.ts                     Entry point, arg parsing, stdio transport
coordinator-server.ts      Core MCP server, tool routing, lazy launch
mcp-proxy.ts               Child MCP subprocess management
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
  - [004-proxy-architecture](docs/adrs/004-proxy-architecture.md) — Proxy architecture for tool merging
  - [005-lazy-browser-launch](docs/adrs/005-lazy-browser-launch.md) — Lazy browser launch strategy
  - [006-two-tier-vscode-integration](docs/adrs/006-two-tier-vscode-integration.md) — Two-tier VS Code integration
  - [007-bun-package-manager](docs/adrs/007-bun-package-manager.md) — Bun as package manager
- `docs/specs/` — Specifications
  - [product](docs/specs/product.md) — Vision, users, success metrics
  - [tech-stack](docs/specs/tech-stack.md) — Runtime, dependencies, commands
  - [boundaries](docs/specs/boundaries.md) — Agent boundaries for this codebase
  - [features/browser-lifecycle](docs/specs/features/browser-lifecycle.md) — Browser management
  - [features/vscode-integration](docs/specs/features/vscode-integration.md) — VS Code companion extension
  - [features/mcp-proxy](docs/specs/features/mcp-proxy.md) — Child MCP proxying

## Boundaries (Quick Reference)

- Keep flat file structure (no `src/` directory)
- No bundler — `tsc` only
- No config files (YAML, TOML) — CLI flags and env vars only
- No database or persistence — stateless process
- Don't send `tools/list_changed` — hosts don't reliably support it
- Don't hardcode Playwright MCP — keep `--mcp` flag working
- Supported browsers: Chrome, Edge, Chromium, Brave (Firefox aspirational)
