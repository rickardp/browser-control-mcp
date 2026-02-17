import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import {
  fsMock, osMock, cpMock, netMock,
  sdkClientMock, sdkTransportMock, sdkServerMock,
  registeredHandlers,
} from "./test-setup.js";

const { CoordinatorServer } = await import("./coordinator-server.js");

describe("CoordinatorServer", () => {
  let mockProc: any;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    registeredHandlers.clear();

    // Save and clear VS Code env vars so isInVSCode() returns false by default
    for (const key of ["TERM_PROGRAM", "VSCODE_INJECTION", "VSCODE_PID", "VSCODE_CWD", "VSCODE_CDP_PORT"]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }

    // Reset SDK client mocks
    sdkClientMock.connect.mockClear();
    sdkClientMock.connect.mockImplementation(async () => {});
    sdkClientMock.close.mockClear();
    sdkClientMock.close.mockImplementation(async () => {});
    sdkClientMock.listTools.mockClear();
    sdkClientMock.listTools.mockImplementation(async () => ({
      tools: [
        { name: "browser_navigate", description: "Navigate to URL", inputSchema: { type: "object" } },
      ],
    }));
    sdkClientMock.callTool.mockClear();
    sdkClientMock.callTool.mockImplementation(async () => ({
      content: [{ type: "text", text: "navigated" }],
    }));
    sdkTransportMock.close.mockClear();
    sdkTransportMock.close.mockImplementation(async () => {});
    sdkServerMock.connect.mockClear();

    // Reset filesystem mocks
    fsMock.existsSync.mockReset();
    fsMock.existsSync.mockReturnValue(false);
    fsMock.readFileSync.mockReset();
    fsMock.readFileSync.mockReturnValue("");
    fsMock.mkdirSync.mockClear();
    fsMock.rmSync.mockClear();

    osMock.platform.mockReturnValue("darwin");
    cpMock.execSync.mockReset();
    cpMock.execSync.mockImplementation(() => { throw new Error("not found"); });

    // Configure net mock for getFreePort
    let portCounter = 9500;
    netMock.createServer.mockImplementation(() => {
      const srv: any = {
        listen(_p: number, cb: () => void) { setTimeout(cb, 0); return srv; },
        address() { return { port: portCounter++ }; },
        close(cb: (err?: Error) => void) { cb(); },
        on() { return srv; },
      };
      return srv;
    });

    netMock.createConnection.mockImplementation((_opts: any, cb: () => void) => {
      const socket = new EventEmitter() as any;
      socket.destroy = mock();
      socket.setTimeout = mock();
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

      // Auto-emit CDP URL after a short delay to make launchBrowser resolve
      setTimeout(() => {
        mockProc.stderr.emit(
          "data",
          Buffer.from("DevTools listening on ws://127.0.0.1:9500/devtools/browser/abc\n")
        );
      }, 5);

      return mockProc;
    });

    // Make Chrome detectable for browser launch
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

  test("initialize connects child MCP proxy", async () => {
    const server = new CoordinatorServer();
    await server.initialize();

    expect(sdkClientMock.connect).toHaveBeenCalledTimes(1);
    expect(sdkClientMock.listTools).toHaveBeenCalledTimes(1);
  });

  test("initialize uses VS Code CDP port when detected", async () => {
    process.env.TERM_PROGRAM = "vscode";
    process.env.VSCODE_CDP_PORT = "9333";

    netMock.createServer.mockClear();
    const server = new CoordinatorServer();
    await server.initialize();

    // Should NOT call createServer (getFreePort) since VS Code provides port
    expect(netMock.createServer).not.toHaveBeenCalled();
  });

  test("initialize skips VS Code detection with noVscode option", async () => {
    process.env.TERM_PROGRAM = "vscode";
    process.env.VSCODE_CDP_PORT = "9333";

    const server = new CoordinatorServer({ noVscode: true });
    await server.initialize();

    // Should call getFreePort even though VS Code env is set
    expect(netMock.createServer).toHaveBeenCalled();
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

    test("tools/list merges coordinator and child tools", async () => {
      const handler = getListToolsHandler();
      expect(handler).toBeDefined();

      const result = await handler!();
      const toolNames = result.tools.map((t: any) => t.name);

      expect(toolNames).toContain("coordinator_list_browsers");
      expect(toolNames).toContain("coordinator_status");
      expect(toolNames).toContain("coordinator_launch_browser");
      expect(toolNames).toContain("coordinator_stop_browser");
      expect(toolNames).toContain("coordinator_restart_browser");
      expect(toolNames).toContain("browser_navigate");
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
      expect(text).toContain("CDP Port:");
      expect(text).toContain("Child MCP:");
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

    test("child tool calls trigger lazy browser launch", async () => {
      const handler = getCallToolHandler();
      cpMock.spawn.mockClear();

      await handler!({
        params: { name: "browser_navigate", arguments: { url: "https://example.com" } },
      });

      // Browser should have been launched (spawn called)
      expect(cpMock.spawn).toHaveBeenCalled();
      // And the tool call should have been forwarded
      expect(sdkClientMock.callTool).toHaveBeenCalledWith({
        name: "browser_navigate",
        arguments: { url: "https://example.com" },
      });
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
    test("stops browser and disconnects proxy", async () => {
      const server = new CoordinatorServer();
      await server.initialize();

      // Trigger a browser launch via a child tool call
      const handler = getCallToolHandler();
      if (handler) {
        cpMock.spawn.mockClear();
        await handler({
          params: { name: "browser_navigate", arguments: {} },
        });
      }

      await server.shutdown();
      expect(sdkClientMock.close).toHaveBeenCalled();
    });

    test("shutdown without browser is safe", async () => {
      const server = new CoordinatorServer();
      await server.initialize();
      await server.shutdown();
      expect(sdkClientMock.close).toHaveBeenCalled();
    });
  });
});
