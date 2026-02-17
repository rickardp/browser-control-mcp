# Agent Boundaries

Rules and constraints for AI agents working in this codebase.

## Code Style

- TypeScript with ESM modules (`import`/`export`, not `require`)
- No bundler — code must compile with `tsc` alone
- Flat file structure in project root (no `src/` directory)
- Compiled output goes to `dist/`

## Architecture Constraints

- **The coordinator is a proxy, not a reimplementation.** Never duplicate browser automation logic that belongs in the child MCP. The coordinator manages lifecycle and forwards tool calls.
- **Zero config by default.** User settings are optional, never required. The server must work with `npx @anthropic-community/browser-coordinator-mcp` and no flags.
- **Lazy browser launch.** Browsers must not spawn at server startup. They launch on the first child MCP tool call. Coordinator-only tools (`coordinator_*`) must work without a running browser.
- **Tool routing by prefix.** `coordinator_*` tools are handled directly. All other tools are forwarded to the child MCP.
- **Single child MCP.** The coordinator spawns exactly one child MCP subprocess. It does not manage multiple child MCPs.

## Browser Support

- **Supported:** Chrome, Edge, Chromium, Brave (all Chromium-based, CDP-compatible)
- **Aspirational:** Firefox (lacks CDP — not currently targetable)
- **Not supported:** Safari/WebKit

## VS Code Integration

- **Tier 1 (External Browser):** Always available, zero config. Must not require the companion extension.
- **Tier 2 (Native CDP):** Requires companion extension. Must degrade gracefully to Tier 1 if extension is not installed.
- **`--no-vscode` flag:** Must completely disable VS Code detection when set.

## What Not to Do

- Do not add a `src/` directory — keep the flat file structure
- Do not add a bundler (webpack, esbuild, rollup) — `tsc` is sufficient
- Do not hardcode Playwright MCP as the only child — keep the `--mcp` flag working
- Do not send `tools/list_changed` notifications — hosts don't reliably support it
- Do not eagerly connect to CDP — let the child MCP handle its own CDP connection timing
- Do not add configuration files (YAML, TOML, JSON config) — use CLI flags and env vars only
- Do not add database or persistence — this is a stateless process
