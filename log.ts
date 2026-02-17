const DEBUG = process.env.BROWSER_COORDINATOR_DEBUG === "1";

export function log(message: string): void {
  if (DEBUG) {
    process.stderr.write(`[browser-coordinator] ${message}\n`);
  }
}

export function logError(message: string, err?: unknown): void {
  const detail = err instanceof Error ? err.message : String(err ?? "");
  process.stderr.write(`[browser-coordinator] ERROR: ${message}${detail ? `: ${detail}` : ""}\n`);
}
