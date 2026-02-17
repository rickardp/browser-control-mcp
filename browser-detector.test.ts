import { describe, test, expect, beforeEach } from "bun:test";
import { fsMock, osMock, cpMock } from "./test-setup.js";

const { detectBrowsers, findBrowser } = await import("./browser-detector.js");

describe("browser-detector", () => {
  beforeEach(() => {
    fsMock.existsSync.mockReset();
    fsMock.existsSync.mockReturnValue(false);
    cpMock.execSync.mockReset();
    cpMock.execSync.mockImplementation(() => { throw new Error("not found"); });
    osMock.platform.mockReturnValue("darwin");
  });

  describe("detectBrowsers()", () => {
    test("returns empty array on unknown platform", () => {
      osMock.platform.mockReturnValue("freebsd");
      expect(detectBrowsers()).toEqual([]);
    });

    test("detects Chrome on macOS", () => {
      fsMock.existsSync.mockImplementation((p: string) =>
        p === "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      );

      const browsers = detectBrowsers();
      expect(browsers.length).toBeGreaterThanOrEqual(1);
      const chrome = browsers.find((b) => b.type === "chrome");
      expect(chrome).toBeDefined();
      expect(chrome!.path).toBe("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
      expect(chrome!.supportsCDP).toBe(true);
    });

    test("detects multiple browsers", () => {
      fsMock.existsSync.mockImplementation((p: string) =>
        p === "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ||
        p === "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
      );

      const browsers = detectBrowsers();
      expect(browsers.length).toBe(2);
      expect(browsers.map((b) => b.type)).toContain("chrome");
      expect(browsers.map((b) => b.type)).toContain("edge");
    });

    test("takes first match per type", () => {
      fsMock.existsSync.mockImplementation((p: string) =>
        p === "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      );

      const chromes = detectBrowsers().filter((b) => b.type === "chrome");
      expect(chromes.length).toBe(1);
    });

    test("falls back to which on macOS/Linux when no paths match", () => {
      cpMock.execSync.mockReturnValue("/usr/local/bin/google-chrome\n");

      const browsers = detectBrowsers();
      expect(browsers.length).toBe(1);
      expect(browsers[0].type).toBe("chrome");
      expect(browsers[0].path).toBe("/usr/local/bin/google-chrome");
    });

    test("which fallback classifies edge correctly", () => {
      let callIndex = 0;
      cpMock.execSync.mockImplementation(() => {
        callIndex++;
        if (callIndex === 4) return "/usr/bin/microsoft-edge\n";
        throw new Error("not found");
      });

      const browsers = detectBrowsers();
      expect(browsers.length).toBe(1);
      expect(browsers[0].type).toBe("edge");
    });

    test("does not use which fallback on win32", () => {
      osMock.platform.mockReturnValue("win32");

      expect(detectBrowsers()).toEqual([]);
      expect(cpMock.execSync).not.toHaveBeenCalled();
    });

    test("detects Brave on macOS", () => {
      fsMock.existsSync.mockImplementation((p: string) =>
        p === "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
      );

      const browsers = detectBrowsers();
      expect(browsers.length).toBe(1);
      expect(browsers[0].type).toBe("brave");
      expect(browsers[0].supportsCDP).toBe(true);
    });

    test("detects Safari on macOS with supportsCDP false", () => {
      fsMock.existsSync.mockImplementation((p: string) =>
        p === "/Applications/Safari.app/Contents/MacOS/Safari"
      );

      const browsers = detectBrowsers();
      expect(browsers.length).toBe(1);
      expect(browsers[0].type).toBe("safari");
      expect(browsers[0].supportsCDP).toBe(false);
      expect(browsers[0].path).toBe("/Applications/Safari.app/Contents/MacOS/Safari");
    });
  });

  describe("findBrowser()", () => {
    test("returns null when no browsers found", () => {
      expect(findBrowser()).toBeNull();
    });

    test("returns preferred browser type when available", () => {
      fsMock.existsSync.mockImplementation((p: string) =>
        p === "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ||
        p === "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
      );

      const result = findBrowser("edge");
      expect(result).toBeDefined();
      expect(result!.type).toBe("edge");
    });

    test("falls back to priority order when preferred not found", () => {
      fsMock.existsSync.mockImplementation((p: string) =>
        p === "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" ||
        p === "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
      );

      const result = findBrowser("chromium");
      expect(result).toBeDefined();
      expect(result!.type).toBe("edge");
    });

    test("prefers chrome over edge in priority order", () => {
      fsMock.existsSync.mockImplementation((p: string) =>
        p === "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ||
        p === "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
      );

      expect(findBrowser()!.type).toBe("chrome");
    });

    test("skips Safari since it does not support CDP", () => {
      fsMock.existsSync.mockImplementation((p: string) =>
        p === "/Applications/Safari.app/Contents/MacOS/Safari"
      );

      expect(findBrowser()).toBeNull();
    });
  });
});
