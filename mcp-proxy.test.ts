import { describe, test, expect, beforeEach } from "bun:test";
import { sdkClientMock, sdkTransportMock } from "./test-setup.js";

const { McpProxy } = await import("./mcp-proxy.js");

describe("McpProxy", () => {
  beforeEach(() => {
    sdkClientMock.connect.mockClear();
    sdkClientMock.connect.mockImplementation(async () => {});
    sdkClientMock.close.mockClear();
    sdkClientMock.close.mockImplementation(async () => {});
    sdkClientMock.listTools.mockClear();
    sdkClientMock.listTools.mockImplementation(async () => ({
      tools: [
        { name: "browser_navigate", description: "Navigate", inputSchema: { type: "object" } },
        { name: "browser_click", description: "Click", inputSchema: { type: "object" } },
      ],
    }));
    sdkClientMock.callTool.mockClear();
    sdkClientMock.callTool.mockImplementation(async () => ({
      content: [{ type: "text", text: "result" }],
    }));
    sdkTransportMock.close.mockClear();
    sdkTransportMock.close.mockImplementation(async () => {});
  });

  test("starts disconnected", () => {
    const proxy = new McpProxy({ command: "node", args: ["test.js"] });
    expect(proxy.isConnected).toBe(false);
    expect(proxy.getTools()).toEqual([]);
    expect(proxy.hasTool("anything")).toBe(false);
  });

  test("connects and fetches tools", async () => {
    const proxy = new McpProxy({ command: "npx", args: ["-y", "@playwright/mcp"] });
    await proxy.connect();

    expect(proxy.isConnected).toBe(true);
    expect(sdkClientMock.connect).toHaveBeenCalledTimes(1);
    expect(sdkClientMock.listTools).toHaveBeenCalledTimes(1);

    const tools = proxy.getTools();
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe("browser_navigate");
  });

  test("hasTool returns true for known tools", async () => {
    const proxy = new McpProxy({ command: "node", args: [] });
    await proxy.connect();

    expect(proxy.hasTool("browser_navigate")).toBe(true);
    expect(proxy.hasTool("browser_click")).toBe(true);
    expect(proxy.hasTool("nonexistent")).toBe(false);
  });

  test("does not reconnect if already connected", async () => {
    const proxy = new McpProxy({ command: "node", args: [] });
    await proxy.connect();
    await proxy.connect();

    expect(sdkClientMock.connect).toHaveBeenCalledTimes(1);
  });

  test("forwards tool calls to child", async () => {
    const proxy = new McpProxy({ command: "node", args: [] });
    await proxy.connect();

    const result = await proxy.callTool("browser_navigate", { url: "https://example.com" });
    expect(sdkClientMock.callTool).toHaveBeenCalledWith({
      name: "browser_navigate",
      arguments: { url: "https://example.com" },
    });
    expect(result.content).toHaveLength(1);
  });

  test("callTool throws when not connected", async () => {
    const proxy = new McpProxy({ command: "node", args: [] });
    await expect(proxy.callTool("test", {})).rejects.toThrow("Child MCP not connected");
  });

  test("refreshTools updates tool list", async () => {
    const proxy = new McpProxy({ command: "node", args: [] });
    await proxy.connect();

    sdkClientMock.listTools.mockImplementation(async () => ({
      tools: [
        { name: "new_tool", description: "New", inputSchema: { type: "object" } },
      ],
    }));

    await proxy.refreshTools();
    expect(proxy.getTools()).toHaveLength(1);
    expect(proxy.hasTool("new_tool")).toBe(true);
    expect(proxy.hasTool("browser_navigate")).toBe(false);
  });

  test("disconnect cleans up state", async () => {
    const proxy = new McpProxy({ command: "node", args: [] });
    await proxy.connect();
    expect(proxy.isConnected).toBe(true);

    await proxy.disconnect();

    expect(proxy.isConnected).toBe(false);
    expect(proxy.getTools()).toEqual([]);
    expect(proxy.hasTool("browser_navigate")).toBe(false);
    expect(sdkClientMock.close).toHaveBeenCalledTimes(1);
    expect(sdkTransportMock.close).toHaveBeenCalledTimes(1);
  });

  test("disconnect is idempotent", async () => {
    const proxy = new McpProxy({ command: "node", args: [] });
    await proxy.disconnect();
    expect(sdkClientMock.close).not.toHaveBeenCalled();
  });

  test("disconnect handles client.close() error gracefully", async () => {
    const proxy = new McpProxy({ command: "node", args: [] });
    await proxy.connect();

    sdkClientMock.close.mockImplementation(async () => {
      throw new Error("already closed");
    });

    await proxy.disconnect();
    expect(proxy.isConnected).toBe(false);
  });
});
