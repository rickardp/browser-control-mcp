import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";

// log.test.ts tests the REAL log module — no test-setup import needed.
// log.ts has no dependencies beyond process.env and process.stderr.
import { log, logError } from "./log.js";

describe("log", () => {
  let stderrSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    stderrSpy = spyOn(process.stderr, "write").mockReturnValue(true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  describe("logError()", () => {
    test("writes prefixed message to stderr", () => {
      logError("something failed");
      expect(stderrSpy).toHaveBeenCalledWith(
        "[browser-coordinator] ERROR: something failed\n"
      );
    });

    test("appends Error.message", () => {
      logError("operation failed", new Error("disk full"));
      expect(stderrSpy).toHaveBeenCalledWith(
        "[browser-coordinator] ERROR: operation failed: disk full\n"
      );
    });

    test("appends string error detail", () => {
      logError("operation failed", "timeout");
      expect(stderrSpy).toHaveBeenCalledWith(
        "[browser-coordinator] ERROR: operation failed: timeout\n"
      );
    });

    test("handles undefined error gracefully", () => {
      logError("something broke", undefined);
      expect(stderrSpy).toHaveBeenCalledWith(
        "[browser-coordinator] ERROR: something broke\n"
      );
    });

    test("handles null error gracefully", () => {
      logError("something broke", null);
      expect(stderrSpy).toHaveBeenCalledWith(
        "[browser-coordinator] ERROR: something broke\n"
      );
    });

    test("converts numeric error to string", () => {
      logError("code", 42);
      expect(stderrSpy).toHaveBeenCalledWith(
        "[browser-coordinator] ERROR: code: 42\n"
      );
    });
  });

  describe("log()", () => {
    test("respects DEBUG gating", () => {
      stderrSpy.mockClear();
      log("test message");

      if (process.env.BROWSER_COORDINATOR_DEBUG === "1") {
        expect(stderrSpy).toHaveBeenCalledWith(
          "[browser-coordinator] test message\n"
        );
      } else {
        expect(stderrSpy).not.toHaveBeenCalled();
      }
    });
  });
});
