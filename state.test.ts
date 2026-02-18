import { describe, test, expect, beforeEach } from "bun:test";
import { fsMock, osMock } from "./test-setup.js";

const { writeState, readState, clearState, getStateFilePath } = await import("./state.js");

describe("state", () => {
  beforeEach(() => {
    fsMock.existsSync.mockReset();
    fsMock.existsSync.mockReturnValue(false);
    fsMock.readFileSync.mockReset();
    fsMock.readFileSync.mockReturnValue("");
    fsMock.writeFileSync.mockClear();
    fsMock.unlinkSync.mockClear();
    fsMock.mkdirSync.mockClear();
    osMock.tmpdir.mockReturnValue("/tmp");
  });

  test("getStateFilePath returns expected path", () => {
    const path = getStateFilePath();
    expect(path).toContain("browser-coordinator");
    expect(path).toContain("state.json");
  });

  describe("writeState()", () => {
    test("creates directory and writes JSON file", () => {
      writeState({ port: 41837, pid: 12345 });

      expect(fsMock.mkdirSync).toHaveBeenCalledTimes(1);
      expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);

      const writtenData = fsMock.writeFileSync.mock.calls[0][1] as string;
      const parsed = JSON.parse(writtenData);
      expect(parsed.port).toBe(41837);
      expect(parsed.pid).toBe(12345);
    });

    test("handles write errors gracefully", () => {
      fsMock.writeFileSync.mockImplementation(() => {
        throw new Error("EACCES");
      });

      // Should not throw
      writeState({ port: 41837, pid: 12345 });
    });
  });

  describe("readState()", () => {
    test("returns null when file does not exist", () => {
      fsMock.existsSync.mockReturnValue(false);

      expect(readState()).toBeNull();
    });

    test("returns state when file exists and is valid", () => {
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue('{"port": 41837, "pid": 12345}');

      const state = readState();
      expect(state).toEqual({ port: 41837, pid: 12345 });
    });

    test("returns null when file contains invalid JSON", () => {
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue("not json");

      expect(readState()).toBeNull();
    });

    test("returns null when file has wrong shape", () => {
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue('{"port": "not a number"}');

      expect(readState()).toBeNull();
    });

    test("returns null when readFileSync throws", () => {
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockImplementation(() => {
        throw new Error("EACCES");
      });

      expect(readState()).toBeNull();
    });
  });

  describe("clearState()", () => {
    test("removes file when it exists", () => {
      fsMock.existsSync.mockReturnValue(true);

      clearState();
      expect(fsMock.unlinkSync).toHaveBeenCalledTimes(1);
    });

    test("does nothing when file does not exist", () => {
      fsMock.existsSync.mockReturnValue(false);

      clearState();
      expect(fsMock.unlinkSync).not.toHaveBeenCalled();
    });

    test("handles errors gracefully", () => {
      fsMock.existsSync.mockReturnValue(true);
      fsMock.unlinkSync.mockImplementation(() => {
        throw new Error("EACCES");
      });

      // Should not throw
      clearState();
    });
  });
});
