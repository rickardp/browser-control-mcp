import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { fsMock, osMock, cpMock } from "./test-setup.js";

const {
  isInVSCode,
  detectVSCode,
  isArgvConfigured,
  findWebviewTarget,
} = await import("./vscode-integration.js");

describe("vscode-integration", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ["TERM_PROGRAM", "VSCODE_INJECTION", "VSCODE_PID", "VSCODE_CWD", "VSCODE_CDP_PORT"]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    fsMock.existsSync.mockReset();
    fsMock.existsSync.mockReturnValue(false);
    fsMock.readFileSync.mockReset();
    fsMock.readFileSync.mockReturnValue("");
    cpMock.execSync.mockReset();
    cpMock.execSync.mockImplementation(() => { throw new Error("no match"); });
    osMock.platform.mockReturnValue("darwin");
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  describe("isInVSCode()", () => {
    test("returns false when no VS Code env vars set", () => {
      expect(isInVSCode()).toBe(false);
    });

    test("detects TERM_PROGRAM=vscode", () => {
      process.env.TERM_PROGRAM = "vscode";
      expect(isInVSCode()).toBe(true);
    });

    test("detects VSCODE_INJECTION=1", () => {
      process.env.VSCODE_INJECTION = "1";
      expect(isInVSCode()).toBe(true);
    });

    test("detects VSCODE_PID", () => {
      process.env.VSCODE_PID = "12345";
      expect(isInVSCode()).toBe(true);
    });

    test("detects VSCODE_CWD", () => {
      process.env.VSCODE_CWD = "/some/path";
      expect(isInVSCode()).toBe(true);
    });
  });

  describe("detectVSCode()", () => {
    test("returns not detected when outside VS Code", () => {
      const result = detectVSCode();
      expect(result.detected).toBe(false);
      expect(result.cdpPort).toBeNull();
      expect(result.terminalIntegration).toBe(false);
    });

    test("discovers CDP port from env var", () => {
      process.env.TERM_PROGRAM = "vscode";
      process.env.VSCODE_CDP_PORT = "9222";

      const result = detectVSCode();
      expect(result.detected).toBe(true);
      expect(result.cdpPort).toBe(9222);
      expect(result.terminalIntegration).toBe(true);
    });

    test("discovers CDP port from port file when env var missing", () => {
      process.env.TERM_PROGRAM = "vscode";
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue("9333\n");

      const result = detectVSCode();
      expect(result.detected).toBe(true);
      expect(result.cdpPort).toBe(9333);
    });

    test("falls back to process scan on darwin", () => {
      process.env.TERM_PROGRAM = "vscode";
      cpMock.execSync.mockReturnValue("electron --remote-debugging-port=9444 --some-other-flag\n");

      const result = detectVSCode();
      expect(result.detected).toBe(true);
      expect(result.cdpPort).toBe(9444);
    });

    test("returns null cdpPort when no source provides it", () => {
      process.env.TERM_PROGRAM = "vscode";

      const result = detectVSCode();
      expect(result.detected).toBe(true);
      expect(result.cdpPort).toBeNull();
    });

    test("ignores invalid CDP port in env var", () => {
      process.env.TERM_PROGRAM = "vscode";
      process.env.VSCODE_CDP_PORT = "not-a-number";

      const result = detectVSCode();
      expect(result.cdpPort).toBeNull();
    });
  });

  describe("isArgvConfigured()", () => {
    test("returns false when argv.json does not exist", () => {
      expect(isArgvConfigured()).toBe(false);
    });

    test("returns true when remote-debugging-port is set", () => {
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue(JSON.stringify({
        "remote-debugging-port": 9222,
      }));

      expect(isArgvConfigured()).toBe(true);
    });

    test("handles JSONC with single-line comments", () => {
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue(`{
  // Enable GPU acceleration
  "enable-crash-reporter": true,
  // CDP for browser coordinator
  "remote-debugging-port": 9222
}`);

      expect(isArgvConfigured()).toBe(true);
    });

    test("handles JSONC with block comments", () => {
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue(`{
  /* This is a config file */
  "remote-debugging-port": 9222
}`);

      expect(isArgvConfigured()).toBe(true);
    });

    test("returns false when key is not present", () => {
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue(JSON.stringify({
        "enable-crash-reporter": true,
      }));

      expect(isArgvConfigured()).toBe(false);
    });

    test("returns false on parse error", () => {
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue("not valid json {{{");

      expect(isArgvConfigured()).toBe(false);
    });
  });

  describe("findWebviewTarget()", () => {
    test("fetches targets from CDP endpoint", async () => {
      const mockTargets = [
        { id: "1", type: "page", url: "https://example.com", webSocketDebuggerUrl: "ws://127.0.0.1:9222/1" },
        { id: "2", type: "page", url: "https://other.com", webSocketDebuggerUrl: "ws://127.0.0.1:9222/2" },
      ];

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => new Response(JSON.stringify(mockTargets))) as any;

      try {
        const target = await findWebviewTarget(9222, "example.com");
        expect(target).toBeDefined();
        expect(target!.id).toBe("1");
        expect(target!.url).toBe("https://example.com");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("returns page-type target when no URL filter", async () => {
      const mockTargets = [
        { id: "bg", type: "background_page", url: "chrome://extensions", webSocketDebuggerUrl: "ws://1" },
        { id: "pg", type: "page", url: "about:blank", webSocketDebuggerUrl: "ws://2" },
      ];

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => new Response(JSON.stringify(mockTargets))) as any;

      try {
        const target = await findWebviewTarget(9222);
        expect(target).toBeDefined();
        expect(target!.id).toBe("pg");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("returns null when fetch fails", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => { throw new Error("connection refused"); }) as any;

      try {
        const target = await findWebviewTarget(9222);
        expect(target).toBeNull();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("returns null when no target matches URL filter", async () => {
      const mockTargets = [
        { id: "1", type: "page", url: "https://other.com", webSocketDebuggerUrl: "ws://1" },
      ];

      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => new Response(JSON.stringify(mockTargets))) as any;

      try {
        const target = await findWebviewTarget(9222, "example.com");
        expect(target).toBeNull();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
