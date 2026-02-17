import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { platform } from "node:os";

export interface BrowserInfo {
  name: string;
  type: "chrome" | "edge" | "chromium" | "brave" | "firefox";
  path: string;
  supportsCDP: boolean;
}

const BROWSER_PATHS: Record<string, Record<string, string[]>> = {
  darwin: {
    chrome: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    ],
    edge: [
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ],
    chromium: [
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ],
    brave: [
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ],
  },
  linux: {
    chrome: [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome-beta",
      "/usr/bin/google-chrome-unstable",
    ],
    edge: [
      "/usr/bin/microsoft-edge",
      "/usr/bin/microsoft-edge-stable",
    ],
    chromium: [
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium",
    ],
    brave: [
      "/usr/bin/brave-browser",
    ],
  },
  win32: {
    chrome: [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      `${process.env.LOCALAPPDATA ?? ""}\\Google\\Chrome\\Application\\chrome.exe`,
    ],
    edge: [
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ],
    chromium: [
      `${process.env.LOCALAPPDATA ?? ""}\\Chromium\\Application\\chrome.exe`,
    ],
    brave: [
      "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
      `${process.env.LOCALAPPDATA ?? ""}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
    ],
  },
};

export function detectBrowsers(): BrowserInfo[] {
  const os = platform();
  const paths = BROWSER_PATHS[os];
  if (!paths) return [];

  const found: BrowserInfo[] = [];

  for (const [type, candidates] of Object.entries(paths)) {
    for (const browserPath of candidates) {
      if (existsSync(browserPath)) {
        found.push({
          name: formatName(type, browserPath),
          type: type as BrowserInfo["type"],
          path: browserPath,
          supportsCDP: type !== "firefox",
        });
        break; // Take first match per type
      }
    }
  }

  // Fallback: try `which` on Linux/macOS
  if (os !== "win32" && found.length === 0) {
    for (const cmd of ["google-chrome", "chromium", "chromium-browser", "microsoft-edge"]) {
      try {
        const p = execSync(`which ${cmd}`, { encoding: "utf8" }).trim();
        if (p) {
          const type = cmd.includes("edge") ? "edge" : cmd.includes("chromium") ? "chromium" : "chrome";
          found.push({
            name: cmd,
            type,
            path: p,
            supportsCDP: true,
          });
          break;
        }
      } catch {
        // not found
      }
    }
  }

  return found;
}

export function findBrowser(preferredType?: string): BrowserInfo | null {
  const browsers = detectBrowsers();
  if (browsers.length === 0) return null;

  if (preferredType) {
    const match = browsers.find((b) => b.type === preferredType && b.supportsCDP);
    if (match) return match;
  }

  // Preference order: chrome > edge > chromium > brave
  const priority = ["chrome", "edge", "chromium", "brave"];
  for (const type of priority) {
    const match = browsers.find((b) => b.type === type && b.supportsCDP);
    if (match) return match;
  }

  return browsers.find((b) => b.supportsCDP) ?? null;
}

function formatName(type: string, path: string): string {
  if (path.includes("Canary")) return "Google Chrome Canary";
  if (path.includes("Beta") || path.includes("beta")) return `${capitalize(type)} Beta`;
  return capitalize(type);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
