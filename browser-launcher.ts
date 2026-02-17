import { ChildProcess, spawn } from "node:child_process";
import * as net from "node:net";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { findBrowser, type BrowserInfo } from "./browser-detector.js";
import { log } from "./log.js";

export interface LauncherOptions {
  browserType?: string;
  browserPath?: string;
  headless?: boolean;
  userDataDir?: string;
}

export interface BrowserInstance {
  browser: BrowserInfo;
  process: ChildProcess;
  cdpPort: number;
  cdpWsUrl: string;
  userDataDir: string;
}

/**
 * Pre-allocate a free TCP port.
 * Standard pattern used by test runners — tiny race window between
 * server close and Chrome binding, negligible in practice.
 */
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const addr = srv.address() as net.AddressInfo;
      const port = addr.port;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    srv.on("error", reject);
  });
}

/**
 * Wait for a TCP port to accept connections.
 */
async function waitForPort(port: number, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection({ port, host: "127.0.0.1" }, () => {
          socket.destroy();
          resolve();
        });
        socket.on("error", reject);
        socket.setTimeout(500, () => {
          socket.destroy();
          reject(new Error("timeout"));
        });
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`Port ${port} did not become available within ${timeoutMs}ms`);
}

/**
 * Create a temporary user data directory for the browser.
 */
function createUserDataDir(): string {
  const dir = path.join(os.tmpdir(), `browser-coordinator-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Launch a browser with CDP enabled on the given port.
 * Returns once "DevTools listening on ws://..." is detected on stderr.
 */
export async function launchBrowser(
  port: number,
  opts: LauncherOptions = {}
): Promise<BrowserInstance> {
  const browser = opts.browserPath
    ? { name: "custom", type: "chrome" as const, path: opts.browserPath, supportsCDP: true }
    : findBrowser(opts.browserType);

  if (!browser) {
    throw new Error(
      "No CDP-capable browser found. Install Chrome, Edge, or Chromium."
    );
  }

  const userDataDir = opts.userDataDir ?? createUserDataDir();

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--disable-translate",
    "--metrics-recording-only",
    "--mute-audio",
  ];

  if (opts.headless !== false) {
    args.push("--headless=new");
  }

  // about:blank as initial page — fast, no network
  args.push("about:blank");

  log(`Launching ${browser.name}: ${browser.path}`);
  log(`  CDP port: ${port}`);
  log(`  User data dir: ${userDataDir}`);

  const proc = spawn(browser.path, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  // Parse CDP WebSocket URL from stderr
  const cdpWsUrl = await new Promise<string>((resolve, reject) => {
    let stderr = "";
    const timeout = setTimeout(() => {
      reject(new Error(`Browser did not produce CDP URL within 15s. stderr: ${stderr}`));
    }, 15000);

    proc.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      log(`[browser stderr] ${text.trim()}`);

      const match = text.match(/DevTools listening on (ws:\/\/.+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    proc.on("exit", (code) => {
      clearTimeout(timeout);
      if (code !== null) {
        reject(new Error(`Browser exited with code ${code}. stderr: ${stderr}`));
      }
    });
  });

  // Also wait for the HTTP endpoint to be ready
  await waitForPort(port, 5000).catch(() => {
    // CDP WS URL is already available, HTTP may follow shortly
    log("Warning: CDP HTTP endpoint not yet available, proceeding with WS URL");
  });

  log(`Browser ready. CDP: ${cdpWsUrl}`);

  return {
    browser,
    process: proc,
    cdpPort: port,
    cdpWsUrl,
    userDataDir,
  };
}

/**
 * Gracefully stop a browser instance.
 */
export function stopBrowser(instance: BrowserInstance): void {
  try {
    if (!instance.process.killed) {
      instance.process.kill("SIGTERM");
      // Force kill after 5s
      setTimeout(() => {
        try {
          if (!instance.process.killed) {
            instance.process.kill("SIGKILL");
          }
        } catch {
          // already dead
        }
      }, 5000);
    }
  } catch {
    // already dead
  }

  // Clean up user data dir (best effort)
  try {
    fs.rmSync(instance.userDataDir, { recursive: true, force: true });
  } catch {
    // may still be locked
  }
}
