/**
 * Shared IPC contract between the VS Code extension (server) and
 * the coordinator MCP (client).
 *
 * Pure interfaces — no runtime code. Compiled by both tsconfigs.
 */

// ─── Request / Response envelope ────────────────────────────────────────────

export interface IpcRequest {
  id: string;
  type: IpcRequestType;
  payload?: Record<string, unknown>;
}

export interface IpcResponse {
  id: string;
  type: string;
  payload?: Record<string, unknown>;
}

export type IpcRequestType =
  | "ping"
  | "get_state"
  | "navigate"
  | "start_element_select"
  | "cancel_element_select";

// ─── Payloads ───────────────────────────────────────────────────────────────

export interface ExtensionState {
  cdpPort: number | null;
  extensionVersion: string;
  workspacePath: string | null;
  activeBrowserUrl: string | null;
}

export interface SelectedElement {
  nodeId: number;
  tagName: string;
  attributes: Record<string, string>;
  boundingBox: { x: number; y: number; width: number; height: number } | null;
  textContent: string;
  cssSelector: string;
}
