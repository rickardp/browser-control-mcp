/**
 * Shared test mock setup. Import this BEFORE any application modules.
 *
 * All test files share the same mock functions. Each test configures
 * behavior via beforeEach using the exported mock objects.
 *
 * This avoids bun's mock.module leak issue (#12823) where multiple
 * test files mocking the same module conflict in a single process.
 */
import { mock } from "bun:test";

// ─── node:fs ────────────────────────────────────────────────────────────────
export const fsMock = {
  existsSync: mock((_path: string): boolean => false),
  readFileSync: mock((_path: string, _enc?: string): string => ""),
  writeFileSync: mock((_path: string, _data: string | Buffer) => {}),
  unlinkSync: mock((_path: string) => {}),
  mkdirSync: mock((_path: string, _opts?: any) => {}),
  rmSync: mock((_path: string, _opts?: any) => {}),
};

// ─── node:os ────────────────────────────────────────────────────────────────
export const osMock = {
  platform: mock((): string => "darwin"),
  homedir: mock((): string => "/Users/testuser"),
  tmpdir: mock((): string => "/tmp"),
};

// ─── node:child_process ─────────────────────────────────────────────────────
export const cpMock = {
  execSync: mock((_cmd: string, _opts?: any): string => { throw new Error("not found"); }),
  spawn: mock((_cmd: string, _args?: string[], _opts?: any): any => null),
};

// ─── node:net ───────────────────────────────────────────────────────────────
export const netMock = {
  createServer: mock((): any => null),
  createConnection: mock((_opts: any, _cb?: () => void): any => null),
};

// ─── @modelcontextprotocol/sdk/server ───────────────────────────────────────
export const registeredHandlers = new Map<string, Function>();

export const sdkServerMock = {
  connect: mock(async () => {}),
};

// ─── Apply all module mocks ─────────────────────────────────────────────────
mock.module("node:fs", () => fsMock);
mock.module("node:os", () => osMock);
mock.module("node:child_process", () => cpMock);
mock.module("node:net", () => netMock);

mock.module("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: class MockServer {
    constructor() {}
    setRequestHandler(schema: any, handler: any) {
      const method = schema?.shape?.method?.value ?? schema?.method ?? schema;
      registeredHandlers.set(method, handler);
    }
    connect = sdkServerMock.connect;
  },
}));

mock.module("@modelcontextprotocol/sdk/types.js", () => ({
  ListToolsRequestSchema: { method: "tools/list" },
  CallToolRequestSchema: { method: "tools/call" },
}));

mock.module("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class MockStdioServerTransport {},
}));

// ─── cdp-client ──────────────────────────────────────────────────────────────
export const cdpClientMock = {
  send: mock(async (_method: string, _params?: any): Promise<any> => ({})),
  close: mock(() => {}),
};

mock.module("./cdp-client.js", () => ({
  connectToTarget: mock(async () => ({
    client: cdpClientMock,
    target: {
      id: "1",
      type: "page",
      title: "test",
      url: "about:blank",
      webSocketDebuggerUrl: "ws://127.0.0.1:9500/devtools/page/1",
    },
  })),
  getTargets: mock(async () => []),
  CdpClient: class MockCdpClient {
    connect = mock(async () => {});
    send = cdpClientMock.send;
    close = cdpClientMock.close;
    on = mock(() => {});
  },
}));
