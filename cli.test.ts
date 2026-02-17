import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import "./test-setup.js";
import { parseArgs } from "./cli.js";

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

  test("parses --mcp with scoped package", () => {
    setArgs("--mcp", "@anthropic-ai/mcp-server-playwright@latest");
    const opts = parseArgs();
    expect(opts.childMcp?.command).toBe("npx");
    expect(opts.childMcp?.args).toContain("-y");
    expect(opts.childMcp?.args).toContain("@anthropic-ai/mcp-server-playwright@latest");
  });

  test("parses --mcp with plain command", () => {
    setArgs("--mcp", "node", "/path/to/server.js", "--flag");
    const opts = parseArgs();
    expect(opts.childMcp?.command).toBe("node");
    expect(opts.childMcp?.args).toEqual(["/path/to/server.js", "--flag"]);
  });

  test("parses --mcp with relative path", () => {
    setArgs("--mcp", "./my-mcp.js");
    const opts = parseArgs();
    expect(opts.childMcp?.command).toBe("npx");
    expect(opts.childMcp?.args).toContain("./my-mcp.js");
  });

  test("parses --mcp with absolute path", () => {
    setArgs("--mcp", "/usr/local/bin/my-mcp");
    const opts = parseArgs();
    expect(opts.childMcp?.command).toBe("npx");
    expect(opts.childMcp?.args).toContain("/usr/local/bin/my-mcp");
  });

  test("combines multiple flags", () => {
    setArgs("--browser", "chrome", "--no-headless", "--no-vscode");
    const opts = parseArgs();
    expect(opts.browser?.browserType).toBe("chrome");
    expect(opts.browser?.headless).toBe(false);
    expect(opts.noVscode).toBe(true);
  });

  test("--mcp consumes remaining args", () => {
    setArgs("--browser", "edge", "--mcp", "@playwright/mcp", "--arg1", "--arg2");
    const opts = parseArgs();
    expect(opts.browser?.browserType).toBe("edge");
    expect(opts.childMcp?.args).toContain("--arg1");
    expect(opts.childMcp?.args).toContain("--arg2");
  });
});
