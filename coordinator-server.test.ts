import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import {
  fsMock, osMock, cpMock, netMock,
  sdkServerMock,
  registeredHandlers,
} from "./test-setup.js";

const { CoordinatorServer } = await import("./coordinator-server.js");

describe("CoordinatorServer", () => {
  let mockProc: any;
  let mockTcpServer: any;
  let connectionHandler: ((socket: any) => void) | null;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    registeredHandlers.clear();
    connectionHandler = null;

    // Save and clear VS Code env vars so isInVSCode() returns false by default
    for (const key of ["TERM_PROGRAM", "VSCODE_INJECTION", "VSCODE_PID", "VSCODE_CWD", "VSCODE_CDP_PORT"]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }

    sdkServerMock.connect.mockClear();

    // Reset filesystem mocks
    fsMock.existsSync.mockReset();
    fsMock.existsSync.mockReturnValue(false);
    fsMock.readFileSync.mockReset();
    fsMock.readFileSync.mockReturnValue("");
    fsMock.writeFileSync.mockClear();
    fsMock.unlinkSync.mockClear();
    fsMock.mkdirSync.mockClear();
    fsMock.rmSync.mockClear();

    osMock.platform.mockReturnValue("darwin");
    osMock.tmpdir.mockReturnValue("/tmp");
    cpMock.execSync.mockReset();
    cpMock.execSync.mockImplementation(() => { throw new Error("not found"); });

    // Configure net mock for CDP proxy (createServer) and getFreePort
    let serverCallCount = 0;
    netMock.createServer.mockImplementation((onConnection?: (socket: any) => void) => {
      serverCallCount++;

      if (onConnection) {
        // This is the CDP proxy's server (has a connection callback)
        connectionHandler = onConnection;
        mockTcpServer = new EventEmitter() as any;
        mockTcpServer.listen = mock((_port: number, _host: string, cb: () => void) => {
          setTimeout(cb, 0);
          return mockTcpServer;
        });
        mockTcpServer.address = mock(() => ({ port: 41837 }));
        mockTcpServer.close = mock((cb: () => void) => { cb(); });
        mockTcpServer.on = mock(function (this: any) { return this; });
        return mockTcpServer;
      }

      // This is getFreePort (no connection callback)
      const srv: any = {
        listen(_p: number, cb: () => void) { setTimeout(cb, 0); return srv; },
        address() { return { port: 9500 + serverCallCount }; },
        close(cb: (err?: Error) => void) { cb(); },
        on() { return srv; },
      };
      return srv;
    });

    netMock.createConnection.mockImplementation((_opts: any, cb: () => void) => {
      const socket = new EventEmitter() as any;
      socket.destroy = mock();
      socket.setTimeout = mock();
      socket.pipe = mock(() => socket);
      setTimeout(() => cb(), 0);
      return socket;
    });

    // Configure spawn mock for launchBrowser
    cpMock.spawn.mockClear();
    cpMock.spawn.mockImplementation(() => {
      mockProc = new EventEmitter() as any;
      mockProc.killed = false;
      mockProc.kill = mock(() => { mockProc.killed = true; });
      mockProc.stderr = new EventEmitter();
      mockProc.stdout = new EventEmitter();
      mockProc.pid = 12345;

      // Auto-emit CDP URL after a short delay
      setTimeout(() => {
        mockProc.stderr.emit(
          "data",
          Buffer.from("DevTools listening on ws://127.0.0.1:9500/devtools/browser/abc\n")
        );
      }, 5);

      return mockProc;
    });

    // Make Chrome detectable
    fsMock.existsSync.mockImplementation((p: string) =>
      p === "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    );
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  function getListToolsHandler() {
    return registeredHandlers.get("tools/list");
  }

  function getCallToolHandler() {
    return registeredHandlers.get("tools/call");
  }

  test("constructs without options", () => {
    const server = new CoordinatorServer();
    expect(server).toBeDefined();
  });

  test("initialize starts CDP proxy and writes state file", async () => {
    const server = new CoordinatorServer();
    await server.initialize();

    // CDP proxy server should have been created
    expect(netMock.createServer).toHaveBeenCalled();
    // State file should have been written
    expect(fsMock.writeFileSync).toHaveBeenCalled();
    const stateData = JSON.parse(fsMock.writeFileSync.mock.calls[0][1] as string);
    expect(stateData.port).toBe(41837);
    expect(stateData.pid).toBe(process.pid);
  });

  test("initialize uses VS Code CDP port when detected", async () => {
    process.env.TERM_PROGRAM = "vscode";
    process.env.VSCODE_CDP_PORT = "9333";

    const server = new CoordinatorServer();
    await server.initialize();

    // State file should still be written with proxy port
    expect(fsMock.writeFileSync).toHaveBeenCalled();
  });

  test("initialize skips VS Code detection with noVscode option", async () => {
    process.env.TERM_PROGRAM = "vscode";
    process.env.VSCODE_CDP_PORT = "9333";

    const server = new CoordinatorServer({ noVscode: true });
    await server.initialize();

    // Should still write state file
    expect(fsMock.writeFileSync).toHaveBeenCalled();
  });

  test("getServer returns the MCP server", () => {
    const server = new CoordinatorServer();
    expect(server.getServer()).toBeDefined();
  });

  describe("tool handlers", () => {
    let server: InstanceType<typeof CoordinatorServer>;

    beforeEach(async () => {
      server = new CoordinatorServer();
      await server.initialize();
    });

    test("tools/list returns only coordinator tools", async () => {
      const handler = getListToolsHandler();
      expect(handler).toBeDefined();

      const result = await handler!();
      const toolNames = result.tools.map((t: any) => t.name);

      expect(toolNames).toContain("coordinator_list_browsers");
      expect(toolNames).toContain("coordinator_status");
      expect(toolNames).toContain("coordinator_launch_browser");
      expect(toolNames).toContain("coordinator_stop_browser");
      expect(toolNames).toContain("coordinator_restart_browser");
      expect(toolNames).toContain("coordinator_navigate");
      expect(toolNames).toContain("coordinator_select_element");
      expect(toolNames).toContain("coordinator_get_dom");
      expect(toolNames).toContain("coordinator_screenshot");
      expect(toolNames).toHaveLength(9);

      // Should NOT contain child MCP tools
      expect(toolNames).not.toContain("browser_navigate");
    });

    test("coordinator_list_browsers returns detected browsers", async () => {
      const handler = getCallToolHandler();

      const result = await handler!({
        params: { name: "coordinator_list_browsers", arguments: {} },
      });

      const text = result.content[0].text;
      expect(text).toContain("Chrome");
    });

    test("coordinator_list_browsers handles no browsers", async () => {
      fsMock.existsSync.mockReturnValue(false);

      const handler = getCallToolHandler();
      const result = await handler!({
        params: { name: "coordinator_list_browsers", arguments: {} },
      });

      expect(result.content[0].text).toContain("No CDP-capable browsers found");
    });

    test("coordinator_status returns status info", async () => {
      const handler = getCallToolHandler();
      const result = await handler!({
        params: { name: "coordinator_status", arguments: {} },
      });

      const text = result.content[0].text;
      expect(text).toContain("Browser:");
      expect(text).toContain("CDP Proxy Port:");
      expect(text).toContain("VS Code:");
    });

    test("coordinator_status does not mention Child MCP", async () => {
      const handler = getCallToolHandler();
      const result = await handler!({
        params: { name: "coordinator_status", arguments: {} },
      });

      const text = result.content[0].text;
      expect(text).not.toContain("Child MCP:");
    });

    test("coordinator_launch_browser launches and sets proxy backend", async () => {
      const handler = getCallToolHandler();
      cpMock.spawn.mockClear();

      const result = await handler!({
        params: { name: "coordinator_launch_browser", arguments: {} },
      });

      expect(cpMock.spawn).toHaveBeenCalled();
      expect(result.content[0].text).toContain("Browser launched");
      expect(result.content[0].text).toContain("CDP proxy port");
    });

    test("coordinator_stop_browser when no browser running", async () => {
      const handler = getCallToolHandler();
      const result = await handler!({
        params: { name: "coordinator_stop_browser", arguments: {} },
      });

      expect(result.content[0].text).toContain("No browser is running");
    });

    test("coordinator_restart_browser when no browser running", async () => {
      const handler = getCallToolHandler();
      const result = await handler!({
        params: { name: "coordinator_restart_browser", arguments: {} },
      });

      expect(result.content[0].text).toContain("No browser was running");
    });

    test("unknown tool returns error message", async () => {
      const handler = getCallToolHandler();
      const result = await handler!({
        params: { name: "nonexistent_tool", arguments: {} },
      });

      expect(result.content[0].text).toContain("Unknown tool: nonexistent_tool");
    });

    test("unknown coordinator tool returns error", async () => {
      const handler = getCallToolHandler();
      const result = await handler!({
        params: { name: "coordinator_nonexistent", arguments: {} },
      });

      expect(result.content[0].text).toContain("Unknown coordinator tool");
    });
  });

  describe("shutdown()", () => {
    test("closes CDP proxy and clears state", async () => {
      const server = new CoordinatorServer();
      await server.initialize();

      // Make state file appear to exist for clearState
      const prevExistsSync = fsMock.existsSync.getMockImplementation();
      fsMock.existsSync.mockImplementation((p: string) => {
        if (p.includes("state.json")) return true;
        return prevExistsSync ? prevExistsSync(p) : false;
      });

      await server.shutdown();
      expect(mockTcpServer.close).toHaveBeenCalled();
      expect(fsMock.unlinkSync).toHaveBeenCalled();
    });

    test("shutdown without browser is safe", async () => {
      const server = new CoordinatorServer();
      await server.initialize();
      await server.shutdown();

      // Should not throw
      expect(mockTcpServer.close).toHaveBeenCalled();
    });
  });
});
