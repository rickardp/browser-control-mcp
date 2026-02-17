import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { log, logError } from "./log.js";

export interface ChildMcpConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export class McpProxy {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private tools: Tool[] = [];
  private toolNames: Set<string> = new Set();
  private connected = false;

  constructor(private config: ChildMcpConfig) {}

  /**
   * Spawn the child MCP process and connect to it.
   * This is fast — child registers tools immediately,
   * no browser connection happens yet (Playwright MCP is lazy).
   */
  async connect(): Promise<void> {
    if (this.connected) return;

    log(`Spawning child MCP: ${this.config.command} ${this.config.args.join(" ")}`);

    this.transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args,
      env: {
        ...process.env,
        ...this.config.env,
      } as Record<string, string>,
    });

    this.client = new Client(
      { name: "browser-coordinator", version: "0.1.0" },
      { capabilities: {} }
    );

    await this.client.connect(this.transport);
    this.connected = true;

    // Fetch available tools from child
    await this.refreshTools();

    log(`Child MCP connected. ${this.tools.length} tools available.`);
  }

  /**
   * Refresh the tool list from the child MCP.
   */
  async refreshTools(): Promise<void> {
    if (!this.client) return;

    const result = await this.client.listTools();
    this.tools = result.tools;
    this.toolNames = new Set(this.tools.map((t) => t.name));

    log(`Child tools: ${this.tools.map((t) => t.name).join(", ")}`);
  }

  /**
   * Get all tools provided by the child MCP.
   */
  getTools(): Tool[] {
    return this.tools;
  }

  /**
   * Check if the child MCP provides a tool with this name.
   */
  hasTool(name: string): boolean {
    return this.toolNames.has(name);
  }

  /**
   * Forward a tool call to the child MCP.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (!this.client) {
      throw new Error("Child MCP not connected");
    }

    log(`Forwarding tool call: ${name}`);

    const result = await this.client.callTool({ name, arguments: args });
    return result as CallToolResult;
  }

  /**
   * Disconnect and kill the child MCP process.
   */
  async disconnect(): Promise<void> {
    if (!this.connected) return;

    try {
      await this.client?.close();
    } catch (err) {
      logError("Error closing child MCP client", err);
    }

    try {
      await this.transport?.close();
    } catch (err) {
      logError("Error closing child MCP transport", err);
    }

    this.client = null;
    this.transport = null;
    this.connected = false;
    this.tools = [];
    this.toolNames.clear();

    log("Child MCP disconnected.");
  }

  get isConnected(): boolean {
    return this.connected;
  }
}
