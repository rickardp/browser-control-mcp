import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { log, logError } from "./log.js";

export interface CoordinatorState {
  port: number;
  pid: number;
}

const STATE_DIR = path.join(os.tmpdir(), "browser-coordinator");
const STATE_FILE = path.join(STATE_DIR, "state.json");

/**
 * Write the coordinator's state (proxy port, PID) to a well-known file.
 * The `wrap` subcommand reads this to inject the port into child MCP args.
 */
export function writeState(state: CoordinatorState): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
    log(`State written: ${STATE_FILE}`);
  } catch (err) {
    logError("Failed to write state file", err);
  }
}

/**
 * Read the coordinator's state from the well-known file.
 * Returns null if the file doesn't exist or can't be parsed.
 */
export function readState(): CoordinatorState | null {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return null;
    }
    const content = fs.readFileSync(STATE_FILE, "utf8");
    const state = JSON.parse(content) as CoordinatorState;
    if (typeof state.port !== "number" || typeof state.pid !== "number") {
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

/**
 * Remove the state file.
 */
export function clearState(): void {
  try {
    if (fs.existsSync(STATE_FILE)) {
      fs.unlinkSync(STATE_FILE);
      log("State file removed");
    }
  } catch (err) {
    logError("Failed to clear state file", err);
  }
}

/**
 * Get the path to the state file (for testing).
 */
export function getStateFilePath(): string {
  return STATE_FILE;
}
