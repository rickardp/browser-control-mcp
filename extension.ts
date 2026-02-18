import * as vscode from "vscode";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { execSync } from "node:child_process";
import type { IpcRequest, IpcResponse, ExtensionState } from "./ipc-types";

const ARGV_PATH = path.join(os.homedir(), ".vscode", "argv.json");
const PORT_FILE = path.join(os.tmpdir(), "vscode-cdp-port");
const EXTENSION_VERSION = "0.2.0";

let statusBarItem: vscode.StatusBarItem;
let cdpPort: number | null = null;
let ipcServer: net.Server | null = null;
let socketPath: string | null = null;
let currentBrowserUrl: string | null = null;
let elementSelectActive = false;
let outputChannel: vscode.OutputChannel;

// ─── Output channel logging ─────────────────────────────────────────────────

function logOutput(msg: string): void {
  outputChannel?.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

// ─── Socket path helpers (mirrored from ipc-socket.ts for the extension) ────

function getSocketDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg || path.join(os.homedir(), ".local", "share");
  const dir = path.join(base, "browser-coordinator-mcp");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function hashWorkspace(workspacePath: string): string {
  return crypto.createHash("sha256").update(workspacePath).digest("hex").slice(0, 8);
}

function getSocketPath(workspacePath: string): string {
  const hash = hashWorkspace(workspacePath);
  if (os.platform() === "win32") {
    return `\\\\.\\pipe\\browser-coordinator-mcp-${hash}`;
  }
  return path.join(getSocketDir(), `ipc-${hash}.sock`);
}

// ─── Activation ─────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  // Output channel for debugging
  outputChannel = vscode.window.createOutputChannel("Browser Coordinator");
  context.subscriptions.push(outputChannel);

  // Status bar
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    50
  );
  statusBarItem.command = "browserCoordinator.showStatus";
  context.subscriptions.push(statusBarItem);

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("browserCoordinator.enableCDP", enableCDP),
    vscode.commands.registerCommand("browserCoordinator.showStatus", showStatus),
    vscode.commands.registerCommand("browserCoordinator.openPreview", openPreview),
    vscode.commands.registerCommand("browserCoordinator.navigate", navigateCommand)
  );

  // Cleanup stale sockets from previous sessions, then start IPC
  cleanupStaleSockets();
  startIpcServer(context);

  // Initialize CDP discovery
  initialize();
}

// ─── IPC Socket Server ──────────────────────────────────────────────────────

function startIpcServer(context: vscode.ExtensionContext): void {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  const workspacePath = workspaceFolders?.[0]?.uri.fsPath;

  if (!workspacePath) {
    logOutput("IPC: no workspace folder — skipping socket server");
    return;
  }

  socketPath = getSocketPath(workspacePath);
  logOutput(`IPC: socket path = ${socketPath}`);

  // Clean stale socket at this specific path
  if (os.platform() !== "win32") {
    try {
      if (fs.existsSync(socketPath)) {
        fs.unlinkSync(socketPath);
        logOutput("IPC: removed stale socket file");
      }
    } catch {
      // ignore
    }
  }

  ipcServer = net.createServer((conn) => {
    let data = "";

    conn.on("data", (chunk) => {
      data += chunk.toString();
      const newlineIdx = data.indexOf("\n");
      if (newlineIdx !== -1) {
        const line = data.slice(0, newlineIdx);
        data = data.slice(newlineIdx + 1);
        handleIpcRequest(conn, line);
      }
    });

    conn.on("error", (err) => {
      logOutput(`IPC: connection error: ${err.message}`);
    });
  });

  ipcServer.on("error", (err) => {
    logOutput(`IPC: server error: ${err.message}`);
  });

  ipcServer.listen(socketPath, () => {
    logOutput(`IPC: server listening on ${socketPath}`);
  });

  context.subscriptions.push({
    dispose: () => {
      stopIpcServer();
    },
  });
}

function stopIpcServer(): void {
  if (ipcServer) {
    ipcServer.close();
    ipcServer = null;
  }
  if (socketPath && os.platform() !== "win32") {
    try {
      if (fs.existsSync(socketPath)) {
        fs.unlinkSync(socketPath);
      }
    } catch {
      // ignore
    }
  }
  socketPath = null;
}

function handleIpcRequest(conn: net.Socket, line: string): void {
  let request: IpcRequest;
  try {
    request = JSON.parse(line) as IpcRequest;
  } catch {
    logOutput(`IPC: invalid JSON: ${line}`);
    conn.end();
    return;
  }

  logOutput(`IPC: request type=${request.type} id=${request.id}`);

  let response: IpcResponse;

  switch (request.type) {
    case "ping":
      response = { id: request.id, type: "ok" };
      break;

    case "get_state":
      response = {
        id: request.id,
        type: "state",
        payload: {
          cdpPort,
          extensionVersion: EXTENSION_VERSION,
          workspacePath: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null,
          activeBrowserUrl: currentBrowserUrl,
        } satisfies ExtensionState as unknown as Record<string, unknown>,
      };
      break;

    case "navigate": {
      const url = request.payload?.url as string | undefined;
      if (url) {
        vscode.commands.executeCommand("simpleBrowser.api.open", url);
        currentBrowserUrl = url;
        updateStatusBar("browser");
        response = { id: request.id, type: "ok" };
        logOutput(`IPC: navigated to ${url}`);
      } else {
        response = { id: request.id, type: "error", payload: { message: "Missing url" } };
      }
      break;
    }

    case "start_element_select":
      elementSelectActive = true;
      updateStatusBar("selecting");
      vscode.window.showInformationMessage(
        "Browser Coordinator: Click an element in the browser preview to select it."
      );
      response = { id: request.id, type: "ok" };
      break;

    case "cancel_element_select":
      elementSelectActive = false;
      updateStatusBar(cdpPort ? "connected" : "browser");
      response = { id: request.id, type: "ok" };
      break;

    default:
      response = { id: request.id, type: "error", payload: { message: `Unknown type: ${request.type}` } };
  }

  conn.write(JSON.stringify(response) + "\n");
  conn.end();
}

// ─── Zombie socket cleanup (Phase 4) ───────────────────────────────────────

function cleanupStaleSockets(): void {
  try {
    const dir = getSocketDir();
    const entries = fs.readdirSync(dir).filter((f) => f.endsWith(".sock"));

    for (const entry of entries) {
      const sockPath = path.join(dir, entry);
      // Try to connect — if it fails, the socket is stale
      const probe = net.createConnection({ path: sockPath }, () => {
        // Connection succeeded — socket is alive, don't delete
        probe.destroy();
      });
      probe.on("error", () => {
        // Connection failed — stale socket
        try {
          fs.unlinkSync(sockPath);
          logOutput(`IPC: cleaned up stale socket: ${entry}`);
        } catch {
          // ignore
        }
      });
      probe.setTimeout(1000, () => {
        probe.destroy();
        try {
          fs.unlinkSync(sockPath);
          logOutput(`IPC: cleaned up timed-out socket: ${entry}`);
        } catch {
          // ignore
        }
      });
    }
  } catch {
    // ignore — directory may not exist yet
  }
}

// ─── Status bar (Phase 4: rich states) ──────────────────────────────────────

type StatusBarState = "off" | "configured" | "connected" | "browser" | "selecting" | "disconnected";

function updateStatusBar(state: StatusBarState): void {
  switch (state) {
    case "off":
      statusBarItem.text = "$(browser) CDP: Off";
      statusBarItem.tooltip = "Click to enable CDP access for browser automation";
      break;
    case "configured":
      statusBarItem.text = "$(browser) CDP: Configured";
      statusBarItem.tooltip = "CDP is configured in argv.json but port not yet discovered. Restart VS Code if needed.";
      break;
    case "connected":
      statusBarItem.text = `$(browser) CDP: ${cdpPort}`;
      statusBarItem.tooltip = `Browser Coordinator: CDP active on port ${cdpPort}`;
      break;
    case "browser":
      statusBarItem.text = "$(browser) VS Code Browser";
      statusBarItem.tooltip = currentBrowserUrl
        ? `Browser Coordinator: ${currentBrowserUrl}`
        : "Browser Coordinator: VS Code Browser active";
      break;
    case "selecting":
      statusBarItem.text = "$(target) Selecting...";
      statusBarItem.tooltip = "Click an element in the browser preview";
      break;
    case "disconnected":
      statusBarItem.text = "$(alert) Disconnected";
      statusBarItem.tooltip = "Browser Coordinator: IPC disconnected";
      break;
  }
  statusBarItem.show();
}

// ─── Initialize ─────────────────────────────────────────────────────────────

async function initialize() {
  const configured = isArgvConfigured();

  if (!configured) {
    updateStatusBar("off");

    const action = await vscode.window.showInformationMessage(
      "Browser Coordinator: Enable CDP access for browser automation inside VS Code?",
      "Enable & Restart",
      "Later"
    );

    if (action === "Enable & Restart") {
      await enableCDP();
    }
    return;
  }

  // CDP is configured — try to discover the port
  cdpPort = discoverPort();

  if (cdpPort) {
    // Write port file for the MCP coordinator (legacy fallback)
    fs.writeFileSync(PORT_FILE, String(cdpPort));

    // Set env for child processes spawned from this terminal (legacy fallback)
    process.env.VSCODE_CDP_PORT = String(cdpPort);

    updateStatusBar("connected");
  } else {
    updateStatusBar("configured");
  }
}

// ─── Commands ───────────────────────────────────────────────────────────────

async function enableCDP() {
  try {
    const vscodeDir = path.dirname(ARGV_PATH);
    if (!fs.existsSync(vscodeDir)) {
      fs.mkdirSync(vscodeDir, { recursive: true });
    }

    let argv: Record<string, unknown> = {};

    if (fs.existsSync(ARGV_PATH)) {
      const content = fs.readFileSync(ARGV_PATH, "utf8");
      const stripped = content
        .replace(/\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      try {
        argv = JSON.parse(stripped);
      } catch {
        fs.copyFileSync(ARGV_PATH, ARGV_PATH + ".bak");
        argv = {};
      }
    }

    argv["remote-debugging-port"] = 0;
    fs.writeFileSync(ARGV_PATH, JSON.stringify(argv, null, "\t") + "\n");

    const action = await vscode.window.showInformationMessage(
      "Browser Coordinator: CDP enabled in argv.json. Restart VS Code to activate.",
      "Restart Now"
    );

    if (action === "Restart Now") {
      vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
  } catch (err) {
    vscode.window.showErrorMessage(
      `Browser Coordinator: Failed to configure argv.json: ${err}`
    );
  }
}

function showStatus() {
  const configured = isArgvConfigured();
  const port = cdpPort ?? discoverPort();

  const lines = [
    `argv.json configured: ${configured ? "Yes" : "No"}`,
    `CDP port: ${port ?? "Not discovered"}`,
    `IPC socket: ${socketPath ?? "Not started"}`,
    `Browser URL: ${currentBrowserUrl ?? "None"}`,
    `Port file (legacy): ${PORT_FILE}`,
    `Env VSCODE_CDP_PORT: ${process.env.VSCODE_CDP_PORT ?? "Not set"}`,
  ];

  vscode.window.showInformationMessage(
    `Browser Coordinator\n${lines.join("\n")}`,
    { modal: true }
  );
}

async function openPreview() {
  const url = await vscode.window.showInputBox({
    prompt: "URL to preview",
    value: "http://localhost:3000",
    placeHolder: "http://localhost:3000",
  });

  if (url) {
    vscode.commands.executeCommand("simpleBrowser.api.open", url);
    currentBrowserUrl = url;
    updateStatusBar("browser");
  }
}

async function navigateCommand() {
  const url = await vscode.window.showInputBox({
    prompt: "Navigate to URL",
    value: currentBrowserUrl ?? "http://localhost:3000",
    placeHolder: "http://localhost:3000",
  });

  if (url) {
    vscode.commands.executeCommand("simpleBrowser.api.open", url);
    currentBrowserUrl = url;
    updateStatusBar("browser");
  }
}

// ─── CDP Discovery (unchanged) ─────────────────────────────────────────────

function isArgvConfigured(): boolean {
  try {
    if (fs.existsSync(ARGV_PATH)) {
      const content = fs.readFileSync(ARGV_PATH, "utf8");
      const stripped = content
        .replace(/\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      const argv = JSON.parse(stripped);
      return argv["remote-debugging-port"] !== undefined;
    }
  } catch {
    // ignore
  }
  return false;
}

function discoverPort(): number | null {
  const osType = os.platform();

  try {
    if (osType === "linux") {
      const pid = process.ppid;
      try {
        const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
        const match = cmdline.match(/--remote-debugging-port=(\d+)/);
        if (match) return parseInt(match[1], 10);
      } catch {
        // Walk up further
      }

      const vscodePid = process.env.VSCODE_PID;
      if (vscodePid) {
        try {
          const cmdline = fs.readFileSync(
            `/proc/${vscodePid}/cmdline`,
            "utf8"
          );
          const match = cmdline.match(/--remote-debugging-port=(\d+)/);
          if (match) return parseInt(match[1], 10);
        } catch {
          // ignore
        }
      }
    }

    if (osType === "darwin" || osType === "linux") {
      const output = execSync(
        'ps aux | grep -E "(code|Code|electron)" | grep "remote-debugging-port"',
        { encoding: "utf8", timeout: 3000 }
      );
      const match = output.match(/--remote-debugging-port=(\d+)/);
      if (match) {
        const port = parseInt(match[1], 10);
        if (port === 0) {
          return findListeningPort();
        }
        return port;
      }
    }

    if (osType === "win32") {
      try {
        const output = execSync(
          'wmic process where "name like \'%Code%\'" get CommandLine',
          { encoding: "utf8", timeout: 5000 }
        );
        const match = output.match(/--remote-debugging-port=(\d+)/);
        if (match) return parseInt(match[1], 10);
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore all failures
  }

  return null;
}

function findListeningPort(): number | null {
  try {
    if (fs.existsSync(PORT_FILE)) {
      const saved = parseInt(fs.readFileSync(PORT_FILE, "utf8").trim(), 10);
      if (!Number.isNaN(saved) && saved > 0) {
        return saved;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

// ─── Deactivation ───────────────────────────────────────────────────────────

export function deactivate() {
  stopIpcServer();

  // Clean up port file (legacy)
  try {
    if (fs.existsSync(PORT_FILE)) {
      fs.unlinkSync(PORT_FILE);
    }
  } catch {
    // ignore
  }
}
