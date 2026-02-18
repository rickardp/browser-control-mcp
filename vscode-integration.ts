import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { log, logError } from "./log.js";
import { discoverExtensionSocket, sendIpcRequest } from "./ipc-socket.js";
import type { ExtensionState } from "./ipc-types.js";

const PORT_FILE = path.join(os.tmpdir(), "vscode-cdp-port");

export interface VSCodeEnvironment {
  detected: boolean;
  cdpPort: number | null;
  terminalIntegration: boolean;
  ipcSocketPath: string | null;
  extensionVersion: string | null;
  activeBrowserUrl: string | null;
}

/**
 * Detect if we're running inside VS Code's integrated terminal.
 */
export function isInVSCode(): boolean {
  return (
    process.env.TERM_PROGRAM === "vscode" ||
    process.env.VSCODE_INJECTION === "1" ||
    !!process.env.VSCODE_PID ||
    !!process.env.VSCODE_CWD
  );
}

/**
 * Detect VS Code environment with IPC-first discovery (async).
 *
 * Priority:
 * 1. IPC socket probe (direct communication with extension)
 * 2. Environment variable set by companion extension
 * 3. Port file written by companion extension
 * 4. Scan VS Code process args
 */
export async function detectVSCodeAsync(): Promise<VSCodeEnvironment> {
  const detected = isInVSCode();

  if (!detected) {
    return {
      detected: false,
      cdpPort: null,
      terminalIntegration: false,
      ipcSocketPath: null,
      extensionVersion: null,
      activeBrowserUrl: null,
    };
  }

  log("VS Code environment detected");

  // 1. Try IPC socket first
  const cwd = process.cwd();
  const ipcSocketPath = await discoverExtensionSocket(cwd);

  if (ipcSocketPath) {
    log(`IPC socket found: ${ipcSocketPath}`);
    try {
      const resp = await sendIpcRequest(ipcSocketPath, {
        id: "init",
        type: "get_state",
      });

      if (resp.type === "state" && resp.payload) {
        const state = resp.payload as unknown as ExtensionState;
        log(`Extension state: version=${state.extensionVersion}, cdpPort=${state.cdpPort}, url=${state.activeBrowserUrl}`);
        return {
          detected: true,
          cdpPort: state.cdpPort,
          terminalIntegration: true,
          ipcSocketPath,
          extensionVersion: state.extensionVersion,
          activeBrowserUrl: state.activeBrowserUrl,
        };
      }
    } catch (err) {
      logError("Failed to get extension state via IPC", err);
    }
  }

  // 2-4. Fall back to legacy discovery
  const cdpPort = discoverCDPPort();

  return {
    detected: true,
    cdpPort,
    terminalIntegration: true,
    ipcSocketPath: null,
    extensionVersion: null,
    activeBrowserUrl: null,
  };
}

/**
 * Synchronous VS Code detection (legacy, still used as fallback).
 */
export function detectVSCode(): VSCodeEnvironment {
  const detected = isInVSCode();

  if (!detected) {
    return {
      detected: false,
      cdpPort: null,
      terminalIntegration: false,
      ipcSocketPath: null,
      extensionVersion: null,
      activeBrowserUrl: null,
    };
  }

  log("VS Code environment detected");
  const cdpPort = discoverCDPPort();

  return {
    detected: true,
    cdpPort,
    terminalIntegration: true,
    ipcSocketPath: null,
    extensionVersion: null,
    activeBrowserUrl: null,
  };
}

/**
 * Discover VS Code's CDP port from various sources (legacy).
 */
function discoverCDPPort(): number | null {
  // 1. Env var from companion extension
  if (process.env.VSCODE_CDP_PORT) {
    const port = parseInt(process.env.VSCODE_CDP_PORT, 10);
    if (!isNaN(port) && port > 0) {
      log(`Found CDP port from env: ${port}`);
      return port;
    }
  }

  // 2. Port file
  try {
    if (fs.existsSync(PORT_FILE)) {
      const content = fs.readFileSync(PORT_FILE, "utf8").trim();
      const port = parseInt(content, 10);
      if (!isNaN(port) && port > 0) {
        log(`Found CDP port from port file: ${port}`);
        return port;
      }
    }
  } catch {
    // ignore
  }

  // 3. Scan VS Code process args
  const port = scanProcessArgs();
  if (port) {
    log(`Found CDP port from process scan: ${port}`);
    return port;
  }

  log("No VS Code CDP port found. Tier 1 mode (external browser + preview).");
  return null;
}

/**
 * Scan the VS Code parent process for --remote-debugging-port=N.
 */
function scanProcessArgs(): number | null {
  const osType = os.platform();

  try {
    if (osType === "linux") {
      const vscodePid = process.env.VSCODE_PID;
      if (vscodePid) {
        const cmdline = fs.readFileSync(`/proc/${vscodePid}/cmdline`, "utf8");
        const match = cmdline.match(/--remote-debugging-port=(\d+)/);
        if (match) return parseInt(match[1], 10);
      }
    } else if (osType === "darwin") {
      const output = execSync(
        "ps aux | grep -E '(code|Code|electron)' | grep remote-debugging-port",
        { encoding: "utf8", timeout: 3000 }
      );
      const match = output.match(/--remote-debugging-port=(\d+)/);
      if (match) return parseInt(match[1], 10);
    }
  } catch {
    // ignore failures
  }

  return null;
}

/**
 * Check if argv.json already has remote-debugging-port configured.
 */
export function isArgvConfigured(): boolean {
  try {
    const argvPath = path.join(os.homedir(), ".vscode", "argv.json");
    if (fs.existsSync(argvPath)) {
      const content = fs.readFileSync(argvPath, "utf8");
      const stripped = content.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      const argv = JSON.parse(stripped);
      return argv["remote-debugging-port"] !== undefined;
    }
  } catch {
    // ignore
  }
  return false;
}

/**
 * Discover webview targets from VS Code's CDP endpoint.
 */
export async function findWebviewTarget(
  cdpPort: number,
  urlFilter?: string
): Promise<{ id: string; webSocketDebuggerUrl: string; url: string } | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${cdpPort}/json`);
    const targets = await response.json() as Array<{
      id: string;
      type: string;
      url: string;
      webSocketDebuggerUrl: string;
    }>;

    log(`Found ${targets.length} CDP targets on port ${cdpPort}`);

    for (const target of targets) {
      if (urlFilter && target.url.includes(urlFilter)) {
        return target;
      }
    }

    if (!urlFilter) {
      return targets.find((t) => t.type === "page") ?? null;
    }
  } catch (err) {
    logError("Failed to query CDP targets", err);
  }

  return null;
}
