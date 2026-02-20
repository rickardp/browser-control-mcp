import { describe, test, expect, mock, beforeEach } from "bun:test";
import { EventEmitter } from "node:events";
import { fsMock, osMock, cpMock, netMock } from "./test-setup.js";

// DON'T mock ./browser-detector.js — let it use the shared fsMock/osMock/cpMock.
// We control findBrowser's output by configuring fsMock.existsSync.

// Configure shared mocks for browser-launcher needs
let mockPort = 9500;
let mockProc: any;

const { getFreePort, launchBrowser, stopBrowser } = await import("./browser-launcher.js");

describe("browser-launcher", () => {
  beforeEach(() => {
    mockPort = 9500;

    // Configure net mock for getFreePort
    netMock.createServer.mockImplementation(() => {
      const srv: any = {
        listen(_port: number, cb: () => void) { setTimeout(cb, 0); return srv; },
        address() { return { port: mockPort }; },
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

    // Configure spawn mock
    cpMock.spawn.mockClear();
    cpMock.spawn.mockImplementation((_cmd: string, _args?: string[]) => {
      mockProc = new EventEmitter() as any;
      mockProc.killed = false;
      mockProc.kill = mock(() => { mockProc.killed = true; });
      mockProc.stderr = new EventEmitter();
      mockProc.stdout = new EventEmitter();
      mockProc.pid = 12345;
      return mockProc;
    });

    // Default: existsSync returns false (no browsers found) — tests that need
    // a browser configure this per-test.
    fsMock.existsSync.mockReset();
    fsMock.existsSync.mockReturnValue(false);
    cpMock.execSync.mockReset();
    cpMock.execSync.mockImplementation(() => { throw new Error("not found"); });
    osMock.platform.mockReturnValue("darwin");

    fsMock.mkdirSync.mockClear();
    fsMock.rmSync.mockClear();
  });

  // Helper: make findBrowser() (via detectBrowsers) find Chrome
  function stubChromeAvailable() {
    fsMock.existsSync.mockImplementation((p: string) =>
      p === "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    );
  }

  describe("getFreePort()", () => {
    test("returns a port number", async () => {
      const port = await getFreePort();
      expect(port).toBe(9500);
    });

    test("returns different port when mock changes", async () => {
      mockPort = 8888;
      const port = await getFreePort();
      expect(port).toBe(8888);
    });
  });

  describe("launchBrowser()", () => {
    test("throws when no browser found", async () => {
      // existsSync returns false, execSync throws → no browsers
      await expect(launchBrowser(9222)).rejects.toThrow(
        "No CDP-capable browser found"
      );
    });

    test("spawns browser with correct args", async () => {
      stubChromeAvailable();
      const launchPromise = launchBrowser(9222);

      await new Promise((r) => setTimeout(r, 10));
      mockProc.stderr.emit(
        "data",
        Buffer.from("DevTools listening on ws://127.0.0.1:9222/devtools/browser/abc123\n")
      );

      const instance = await launchPromise;

      expect(cpMock.spawn).toHaveBeenCalledTimes(1);
      const args = cpMock.spawn.mock.calls[0][1] as string[];
      expect(args).toContain("--remote-debugging-port=9222");
      expect(args).toContain("--no-first-run");
      expect(args).toContain("--headless=new");
      expect(args).toContain("about:blank");
      expect(instance.cdpPort).toBe(9222);
      expect(instance.cdpWsUrl).toBe("ws://127.0.0.1:9222/devtools/browser/abc123");
    });

    test("uses custom browser path when provided", async () => {
      // browserPath bypasses findBrowser entirely
      const launchPromise = launchBrowser(9222, { browserPath: "/custom/browser" });

      await new Promise((r) => setTimeout(r, 10));
      mockProc.stderr.emit(
        "data",
        Buffer.from("DevTools listening on ws://127.0.0.1:9222/devtools/browser/abc\n")
      );

      const instance = await launchPromise;
      expect(cpMock.spawn.mock.calls[0][0]).toBe("/custom/browser");
      expect(instance.browser.name).toBe("custom");
    });

    test("omits --headless=new when headless is false", async () => {
      stubChromeAvailable();
      const launchPromise = launchBrowser(9222, { headless: false });

      await new Promise((r) => setTimeout(r, 10));
      mockProc.stderr.emit(
        "data",
        Buffer.from("DevTools listening on ws://127.0.0.1:9222/devtools/browser/abc\n")
      );

      await launchPromise;
      const args = cpMock.spawn.mock.calls[0][1] as string[];
      expect(args).not.toContain("--headless=new");
    });

    test("rejects when browser process exits with error code", async () => {
      stubChromeAvailable();
      const launchPromise = launchBrowser(9222);

      await new Promise((r) => setTimeout(r, 10));
      mockProc.emit("exit", 1);

      await expect(launchPromise).rejects.toThrow("Browser exited with code 1");
    });

    test("rejects when browser process emits error", async () => {
      stubChromeAvailable();
      const launchPromise = launchBrowser(9222);

      await new Promise((r) => setTimeout(r, 10));
      mockProc.emit("error", new Error("spawn ENOENT"));

      await expect(launchPromise).rejects.toThrow("spawn ENOENT");
    });
  });

  describe("stopBrowser()", () => {
    test("kills the process and cleans up user data dir", () => {
      const killMock = mock(function (this: any) { this.killed = true; });
      const proc = { killed: false, kill: killMock };

      stopBrowser({
        browser: { name: "Chrome", type: "chrome", path: "/usr/bin/chrome", supportsCDP: true, supportsBidi: false },
        process: proc as any,
        engine: "chromium" as const,
        cdpPort: 9222,
        cdpWsUrl: "ws://127.0.0.1:9222/devtools/browser/abc",
        bidiWsUrl: null,
        userDataDir: "/tmp/test-profile",
      });

      expect(killMock).toHaveBeenCalledWith("SIGTERM");
      expect(fsMock.rmSync).toHaveBeenCalledWith("/tmp/test-profile", { recursive: true, force: true });
    });

    test("handles already-killed process gracefully", () => {
      const killMock = mock();
      const proc = { killed: true, kill: killMock };

      stopBrowser({
        browser: { name: "Chrome", type: "chrome", path: "/usr/bin/chrome", supportsCDP: true, supportsBidi: false },
        process: proc as any,
        engine: "chromium" as const,
        cdpPort: 9222,
        cdpWsUrl: "ws://127.0.0.1:9222/devtools/browser/abc",
        bidiWsUrl: null,
        userDataDir: "/tmp/test-profile",
      });

      expect(killMock).not.toHaveBeenCalled();
    });
  });
});
