/**
 * Coordinator-side IPC client.
 *
 * Connects to the VS Code extension's Unix domain socket (or named pipe on Windows)
 * to exchange JSON request/response messages.
 */

import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import type { IpcRequest, IpcResponse } from "./ipc-types.js";
import { log, logError } from "./log.js";

// ─── Socket path helpers ────────────────────────────────────────────────────

/**
 * Get the directory for IPC socket files.
 *
 * - macOS/Linux: $XDG_DATA_HOME/browser-coordinator-mcp/ (default ~/.local/share/...)
 * - Windows: uses named pipes instead (no directory needed)
 */
export function getSocketDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg || path.join(os.homedir(), ".local", "share");
  const dir = path.join(base, "browser-coordinator-mcp");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Compute a short hash of the workspace path for socket naming.
 */
function hashWorkspace(workspacePath: string): string {
  return crypto.createHash("sha256").update(workspacePath).digest("hex").slice(0, 8);
}

/**
 * Get the socket path for a given workspace.
 *
 * - macOS/Linux: {socketDir}/ipc-{hash}.sock
 * - Windows: \\.\pipe\browser-coordinator-mcp-{hash}
 */
export function getSocketPath(workspacePath: string): string {
  const hash = hashWorkspace(workspacePath);
  if (os.platform() === "win32") {
    return `\\\\.\\pipe\\browser-coordinator-mcp-${hash}`;
  }
  return path.join(getSocketDir(), `ipc-${hash}.sock`);
}

// ─── IPC client ─────────────────────────────────────────────────────────────

/**
 * Send a single IPC request to the extension socket server.
 *
 * Opens a connection, writes JSON + newline, reads a JSON response, disconnects.
 */
export function sendIpcRequest(
  socketPath: string,
  request: IpcRequest,
  timeout = 5000
): Promise<IpcResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath }, () => {
      socket.write(JSON.stringify(request) + "\n");
    });

    let data = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`IPC request timed out after ${timeout}ms`));
    }, timeout);

    socket.on("data", (chunk) => {
      data += chunk.toString();
      // Responses are newline-delimited JSON
      const newlineIdx = data.indexOf("\n");
      if (newlineIdx !== -1) {
        clearTimeout(timer);
        const line = data.slice(0, newlineIdx);
        socket.destroy();
        try {
          resolve(JSON.parse(line) as IpcResponse);
        } catch (err) {
          reject(new Error(`Invalid IPC response JSON: ${line}`));
        }
      }
    });

    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    socket.on("close", () => {
      clearTimeout(timer);
      // If we haven't resolved yet, we didn't get a full response
      if (data.indexOf("\n") === -1) {
        reject(new Error("IPC connection closed before response"));
      }
    });
  });
}

/**
 * Probe a socket to check if the extension is alive.
 */
export async function probeSocket(socketPath: string): Promise<boolean> {
  try {
    const resp = await sendIpcRequest(socketPath, {
      id: "probe",
      type: "ping",
    }, 2000);
    return resp.type === "ok";
  } catch {
    return false;
  }
}

/**
 * Discover the extension's IPC socket.
 *
 * Strategy:
 * 1. If cwd is provided, try the workspace-specific socket first.
 * 2. Scan the socket directory for .sock files, probe each.
 * 3. Return the first healthy match.
 */
export async function discoverExtensionSocket(
  cwd?: string
): Promise<string | null> {
  // 1. Try CWD-based socket first
  if (cwd) {
    const specific = getSocketPath(cwd);
    log(`IPC: trying workspace socket ${specific}`);
    if (fs.existsSync(specific) && await probeSocket(specific)) {
      log(`IPC: found workspace socket at ${specific}`);
      return specific;
    }
  }

  // 2. Scan socket directory
  const dir = getSocketDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith(".sock"));
  } catch {
    return null;
  }

  for (const entry of entries) {
    const sockPath = path.join(dir, entry);
    log(`IPC: probing ${sockPath}`);
    if (await probeSocket(sockPath)) {
      log(`IPC: found healthy socket at ${sockPath}`);
      return sockPath;
    } else {
      // Stale socket — clean it up
      log(`IPC: removing stale socket ${sockPath}`);
      try { fs.unlinkSync(sockPath); } catch { /* ignore */ }
    }
  }

  return null;
}
