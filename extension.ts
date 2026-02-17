import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";

const ARGV_PATH = path.join(os.homedir(), ".vscode", "argv.json");
const PORT_FILE = path.join(os.tmpdir(), "vscode-cdp-port");

let statusBarItem: vscode.StatusBarItem;
let cdpPort: number | null = null;

export function activate(context: vscode.ExtensionContext) {
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
    vscode.commands.registerCommand("browserCoordinator.openPreview", openPreview)
  );

  // On activation: check CDP and discover port
  initialize();
}

async function initialize() {
  const configured = isArgvConfigured();

  if (!configured) {
    // First time — offer to enable CDP
    statusBarItem.text = "$(browser) CDP: Off";
    statusBarItem.tooltip = "Click to enable CDP access for browser automation";
    statusBarItem.show();

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
    // Write port file for the MCP coordinator
    fs.writeFileSync(PORT_FILE, String(cdpPort));

    // Set env for child processes spawned from this terminal
    process.env.VSCODE_CDP_PORT = String(cdpPort);

    statusBarItem.text = `$(browser) CDP: ${cdpPort}`;
    statusBarItem.tooltip = `Browser Coordinator: CDP active on port ${cdpPort}`;
    statusBarItem.show();
  } else {
    statusBarItem.text = "$(browser) CDP: Configured";
    statusBarItem.tooltip =
      "CDP is configured in argv.json but port not yet discovered. Restart VS Code if needed.";
    statusBarItem.show();
  }
}

/**
 * Enable CDP by writing to argv.json and prompting restart.
 */
async function enableCDP() {
  try {
    // Ensure .vscode directory exists
    const vscodeDir = path.dirname(ARGV_PATH);
    if (!fs.existsSync(vscodeDir)) {
      fs.mkdirSync(vscodeDir, { recursive: true });
    }

    let argv: Record<string, unknown> = {};

    if (fs.existsSync(ARGV_PATH)) {
      const content = fs.readFileSync(ARGV_PATH, "utf8");
      // argv.json is JSONC (may have comments), strip them
      const stripped = content
        .replace(/\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      try {
        argv = JSON.parse(stripped);
      } catch {
        // If parse fails, read the raw file and try to merge carefully
        // Back up the original
        fs.copyFileSync(ARGV_PATH, ARGV_PATH + ".bak");
        argv = {};
      }
    }

    // Add remote-debugging-port=0 (OS picks a free port)
    argv["remote-debugging-port"] = 0;

    // Write back — preserve formatting with tabs (VS Code convention)
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

/**
 * Show status information.
 */
function showStatus() {
  const configured = isArgvConfigured();
  const port = cdpPort ?? discoverPort();

  const lines = [
    `argv.json configured: ${configured ? "Yes" : "No"}`,
    `CDP port: ${port ?? "Not discovered"}`,
    `Port file: ${PORT_FILE}`,
    `Env VSCODE_CDP_PORT: ${process.env.VSCODE_CDP_PORT ?? "Not set"}`,
  ];

  vscode.window.showInformationMessage(
    `Browser Coordinator\n${lines.join("\n")}`,
    { modal: true }
  );
}

/**
 * Open a URL in VS Code's Simple Browser.
 */
async function openPreview() {
  const url = await vscode.window.showInputBox({
    prompt: "URL to preview",
    value: "http://localhost:3000",
    placeHolder: "http://localhost:3000",
  });

  if (url) {
    vscode.commands.executeCommand("simpleBrowser.api.open", url);
  }
}

/**
 * Check if argv.json has remote-debugging-port configured.
 */
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

/**
 * Discover the actual CDP port from VS Code's process args.
 */
function discoverPort(): number | null {
  const osType = os.platform();

  try {
    if (osType === "linux") {
      // Read own process tree for the flag
      const pid = process.ppid;
      try {
        const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
        const match = cmdline.match(/--remote-debugging-port=(\d+)/);
        if (match) return parseInt(match[1], 10);
      } catch {
        // Walk up further
      }

      // Try the VSCODE_PID
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
      // Fallback: ps scan
      const output = execSync(
        'ps aux | grep -E "(code|Code|electron)" | grep "remote-debugging-port"',
        { encoding: "utf8", timeout: 3000 }
      );
      const match = output.match(/--remote-debugging-port=(\d+)/);
      if (match) {
        const port = parseInt(match[1], 10);
        // Port 0 means "let OS pick" — need to find actual port from listening sockets
        if (port === 0) {
          return findListeningPort();
        }
        return port;
      }
    }

    if (osType === "win32") {
      // Windows: use netstat or wmic
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

/**
 * When port=0 was specified, find which port VS Code's Electron is actually listening on.
 * We probe common high ports looking for a CDP /json endpoint.
 */
function findListeningPort(): number | null {
  // The port file from a previous session might still be valid
  try {
    if (fs.existsSync(PORT_FILE)) {
      const saved = parseInt(fs.readFileSync(PORT_FILE, "utf8").trim(), 10);
      if (!Number.isNaN(saved) && saved > 0) {
        // TODO: verify it's actually responding with CDP /json
        return saved;
      }
    }
  } catch {
    // ignore
  }

  // TODO: Could scan /proc/net/tcp or use lsof to find the port
  // For now, return null and rely on the port file from next restart

  return null;
}

export function deactivate() {
  // Clean up port file
  try {
    if (fs.existsSync(PORT_FILE)) {
      fs.unlinkSync(PORT_FILE);
    }
  } catch {
    // ignore
  }
}
