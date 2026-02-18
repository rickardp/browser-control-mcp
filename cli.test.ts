import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import "./test-setup.js";
import { parseArgs, parseWrapArgs, injectPort } from "./cli.js";

describe("parseArgs", () => {
  let originalArgv: string[];

  beforeEach(() => {
    originalArgv = process.argv;
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  function setArgs(...args: string[]) {
    process.argv = ["node", "cli.js", ...args];
  }

  test("returns empty options with no args", () => {
    setArgs();
    const opts = parseArgs();
    expect(opts).toEqual({});
  });

  test("parses --browser flag", () => {
    setArgs("--browser", "edge");
    const opts = parseArgs();
    expect(opts.browser?.browserType).toBe("edge");
  });

  test("parses --browser-path flag", () => {
    setArgs("--browser-path", "/custom/chrome");
    const opts = parseArgs();
    expect(opts.browser?.browserPath).toBe("/custom/chrome");
  });

  test("parses --no-headless flag", () => {
    setArgs("--no-headless");
    const opts = parseArgs();
    expect(opts.browser?.headless).toBe(false);
  });

  test("parses --no-vscode flag", () => {
    setArgs("--no-vscode");
    const opts = parseArgs();
    expect(opts.noVscode).toBe(true);
  });

  test("combines multiple flags", () => {
    setArgs("--browser", "chrome", "--no-headless", "--no-vscode");
    const opts = parseArgs();
    expect(opts.browser?.browserType).toBe("chrome");
    expect(opts.browser?.headless).toBe(false);
    expect(opts.noVscode).toBe(true);
  });
});

describe("parseWrapArgs", () => {
  let originalArgv: string[];

  beforeEach(() => {
    originalArgv = process.argv;
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  function setArgs(...args: string[]) {
    process.argv = ["node", "cli.js", ...args];
  }

  test("returns null when not a wrap invocation", () => {
    setArgs("--browser", "chrome");
    expect(parseWrapArgs()).toBeNull();
  });

  test("returns null with no args", () => {
    setArgs();
    expect(parseWrapArgs()).toBeNull();
  });

  test("parses wrap with child command", () => {
    setArgs("wrap", "--", "npx", "-y", "@playwright/mcp", "--cdp-endpoint={cdp_endpoint}");
    const result = parseWrapArgs();
    expect(result).toBeDefined();
    expect(result!.childCommand).toBe("npx");
    expect(result!.childArgs).toEqual(["-y", "@playwright/mcp", "--cdp-endpoint={cdp_endpoint}"]);
  });

  test("parses wrap with simple command", () => {
    setArgs("wrap", "--", "node", "server.js");
    const result = parseWrapArgs();
    expect(result!.childCommand).toBe("node");
    expect(result!.childArgs).toEqual(["server.js"]);
  });
});

describe("injectPort", () => {
  test("replaces {cdp_port} with port number", () => {
    const result = injectPort(["--port={cdp_port}"], 41837);
    expect(result).toEqual(["--port=41837"]);
  });

  test("replaces {cdp_endpoint} with full URL", () => {
    const result = injectPort(["--cdp-endpoint={cdp_endpoint}"], 41837);
    expect(result).toEqual(["--cdp-endpoint=http://localhost:41837"]);
  });

  test("replaces multiple occurrences", () => {
    const result = injectPort(
      ["--a={cdp_port}", "--b={cdp_endpoint}", "--c=plain"],
      9222
    );
    expect(result).toEqual([
      "--a=9222",
      "--b=http://localhost:9222",
      "--c=plain",
    ]);
  });

  test("leaves args without templates unchanged", () => {
    const result = injectPort(["--flag", "value"], 9222);
    expect(result).toEqual(["--flag", "value"]);
  });
});
