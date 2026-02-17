# Tech Stack Specification

## Runtime

- **Node.js** >= 18 (ESM modules, `"type": "module"`)
- **TypeScript** 5.7+ (compiled via `tsc`, no bundler)

## Dependencies

### Production

| Package | Version | Purpose |
|---------|---------|---------|
| `@modelcontextprotocol/sdk` | ^1.12.0 | MCP server + client implementation |

### Development

| Package | Version | Purpose |
|---------|---------|---------|
| `typescript` | ^5.7.0 | TypeScript compiler |
| `@types/node` | ^22.0.0 | Node.js type definitions |

## Project Structure

```
browser-control-mcp/
  cli.ts                     # Entry point, arg parsing, stdio transport
  coordinator-server.ts      # Core MCP server, tool routing, lazy launch
  mcp-proxy.ts               # Child MCP subprocess management
  browser-launcher.ts        # Port allocation, browser spawn, lifecycle
  browser-detector.ts        # Cross-platform browser detection
  vscode-integration.ts      # VS Code environment detection, CDP discovery
  extension.ts               # VS Code companion extension
  package.json
  README.md
  docs/
    adrs/                    # Architecture Decision Records
    specs/                   # Product and technical specifications
      features/              # Feature specifications
  CLAUDE.md                  # Agent instructions
```

## Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript (`tsc`) |
| `npm run dev` | Watch mode (`tsc --watch`) |
| `npm start` | Run compiled server (`node dist/cli.js`) |
| `npm run prepare` | Pre-install build hook (`tsc`) |

## CLI

```
npx @anthropic-community/browser-coordinator-mcp [options]

Options:
  --mcp <package>       Child MCP server (default: @anthropic-ai/mcp-server-playwright)
  --browser <type>      Preferred browser: chrome, edge, chromium, brave
  --browser-path <path> Explicit browser executable path
  --no-headless         Show browser UI (default: headless)
  --no-vscode           Disable VS Code integration detection
  --help, -h            Show help
```

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `BROWSER_COORDINATOR_DEBUG=1` | Enable debug logging to stderr |
| `VSCODE_CDP_PORT=<port>` | VS Code CDP port (set by companion extension) |

## Conventions

- All source files are in the project root (flat structure, no `src/` directory)
- Output compiles to `dist/`
- No linter or formatter configured yet
- No test framework configured yet
- No bundler — raw `tsc` compilation
