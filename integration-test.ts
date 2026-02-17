/**
 * Integration test for browser detection and port allocation.
 * Runs directly with `bun run integration-test.ts` — no test framework needed.
 * Uses real system modules (no mocks).
 */

import { detectBrowsers, findBrowser } from "./browser-detector.js";
import { getFreePort, launchBrowser, stopBrowser, type BrowserInstance } from "./browser-launcher.js";
import { platform } from "node:os";
import assert from "node:assert";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      passed++;
      console.log(`  PASS  ${name}`);
    })
    .catch((err: unknown) => {
      failed++;
      console.error(`  FAIL  ${name}`);
      console.error(`        ${err}`);
    });
}

console.log(`Platform: ${platform()}\n`);

const browsers = detectBrowsers();
console.log(
  `Detected browsers: ${browsers.map((b) => `${b.name} (${b.type})`).join(", ") || "none"}\n`
);

await test("detectBrowsers() finds at least 1 browser", () => {
  assert.ok(browsers.length >= 1, `Expected >=1 browser, got ${browsers.length}`);
});

await test("Chrome is detected", () => {
  const chrome = browsers.find((b) => b.type === "chrome");
  assert.ok(chrome, "Chrome not found");
});

await test("Edge is detected", () => {
  const edge = browsers.find((b) => b.type === "edge");
  assert.ok(edge, "Edge not found");
});

if (platform() === "linux") {
  await test("Chromium is detected on Linux", () => {
    const chromium = browsers.find((b) => b.type === "chromium");
    assert.ok(chromium, "Chromium not found on Linux");
  });
}

if (platform() === "darwin") {
  await test("Safari is detected on macOS", () => {
    const safari = browsers.find((b) => b.type === "safari");
    assert.ok(safari, "Safari not found on macOS");
  });

  await test("Safari does not support CDP", () => {
    const safari = browsers.find((b) => b.type === "safari");
    assert.ok(safari, "Safari not found on macOS");
    assert.strictEqual(safari.supportsCDP, false, "Safari should not support CDP");
  });
}

await test("findBrowser() returns Chrome as top priority", () => {
  const top = findBrowser();
  assert.ok(top, "findBrowser() returned null");
  assert.strictEqual(top.type, "chrome", `Expected chrome, got ${top.type}`);
});

await test("findBrowser('edge') returns Edge", () => {
  const edge = findBrowser("edge");
  assert.ok(edge, "findBrowser('edge') returned null");
  assert.strictEqual(edge.type, "edge", `Expected edge, got ${edge.type}`);
});

await test("getFreePort() returns a valid port number", async () => {
  const port = await getFreePort();
  assert.ok(Number.isInteger(port), `Port is not an integer: ${port}`);
  assert.ok(port > 0 && port <= 65535, `Port out of range: ${port}`);
});

await test("getFreePort() returns different ports on consecutive calls", async () => {
  const port1 = await getFreePort();
  const port2 = await getFreePort();
  assert.notStrictEqual(port1, port2, `Both calls returned the same port: ${port1}`);
});

// ── Browser Launch & Navigation ──────────────────────────────────────────────

let cdpMsgId = 0;

/**
 * Send a CDP command over WebSocket and wait for the matching response.
 */
function cdpSend(
  ws: WebSocket,
  method: string,
  params: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const id = ++cdpMsgId;
    const timeout = setTimeout(() => reject(new Error(`CDP ${method} timed out`)), 10000);

    const handler = (event: MessageEvent) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id === id) {
        ws.removeEventListener("message", handler);
        clearTimeout(timeout);
        if (msg.error) {
          reject(new Error(`CDP error: ${JSON.stringify(msg.error)}`));
        } else {
          resolve(msg.result ?? {});
        }
      }
    };
    ws.addEventListener("message", handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const cdpBrowsers = browsers.filter((b) => b.supportsCDP);
console.log(
  `\nCDP-capable browsers for launch tests: ${cdpBrowsers.map((b) => b.name).join(", ") || "none"}\n`
);

for (const browserInfo of cdpBrowsers) {
  let instance: BrowserInstance | undefined;

  try {
    // Test 1: Browser launches headlessly
    await test(`${browserInfo.name} launches headlessly`, async () => {
      const port = await getFreePort();
      instance = await launchBrowser(port, { browserType: browserInfo.type });
      assert.ok(instance, "launchBrowser() returned falsy");
      assert.ok(instance.cdpPort > 0, `Invalid CDP port: ${instance.cdpPort}`);
      assert.ok(
        instance.cdpWsUrl.startsWith("ws://"),
        `Invalid CDP WS URL: ${instance.cdpWsUrl}`
      );
    });

    // Test 2: CDP endpoint responds
    await test(`${browserInfo.name} CDP endpoint responds`, async () => {
      assert.ok(instance, "No browser instance (launch failed)");
      const res = await fetch(`http://127.0.0.1:${instance.cdpPort}/json/version`);
      assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
      const json = (await res.json()) as Record<string, unknown>;
      assert.ok(json.Browser, `Missing "Browser" field in /json/version response`);
    });

    // Test 3: Navigate to a page via CDP
    await test(`${browserInfo.name} navigates to a page`, async () => {
      assert.ok(instance, "No browser instance (launch failed)");

      // Get the page target
      const targets = (await (
        await fetch(`http://127.0.0.1:${instance.cdpPort}/json`)
      ).json()) as Array<Record<string, string>>;
      const pageTarget = targets.find((t) => t.type === "page");
      assert.ok(pageTarget, "No page target found in /json");
      assert.ok(pageTarget.webSocketDebuggerUrl, "No webSocketDebuggerUrl on page target");

      // Connect via WebSocket and navigate
      const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", (e) => reject(new Error(`WS connect failed: ${e}`)));
        setTimeout(() => reject(new Error("WS connect timed out")), 5000);
      });

      try {
        await cdpSend(ws, "Page.enable");
        await cdpSend(ws, "Page.navigate", {
          url: "data:text/html,<title>Hello</title>",
        });

        // Give the browser a moment to update the target info
        await new Promise((r) => setTimeout(r, 500));

        // Verify navigation via /json
        const updatedTargets = (await (
          await fetch(`http://127.0.0.1:${instance.cdpPort}/json`)
        ).json()) as Array<Record<string, string>>;
        const updatedPage = updatedTargets.find((t) => t.type === "page");
        assert.ok(updatedPage, "No page target found after navigation");
        assert.ok(
          updatedPage.url.includes("data:text/html"),
          `Expected data: URL, got: ${updatedPage.url}`
        );
      } finally {
        ws.close();
      }
    });

    // Test 4: Browser stops cleanly
    await test(`${browserInfo.name} stops cleanly`, async () => {
      assert.ok(instance, "No browser instance (launch failed)");
      stopBrowser(instance);

      // Wait for process to exit (up to 5s)
      await new Promise<void>((resolve) => {
        if (instance!.process.exitCode !== null) {
          resolve();
          return;
        }
        instance!.process.on("exit", () => resolve());
        setTimeout(() => resolve(), 5000);
      });

      assert.ok(
        instance.process.killed || instance.process.exitCode !== null,
        "Browser process still running after stopBrowser()"
      );
      instance = undefined;
    });
  } finally {
    // Guarantee cleanup even if tests throw
    if (instance) {
      try {
        stopBrowser(instance);
      } catch {
        // best effort
      }
    }
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
