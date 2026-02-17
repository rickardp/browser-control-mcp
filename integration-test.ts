/**
 * Integration test for browser detection and port allocation.
 * Runs directly with `bun run integration-test.ts` — no test framework needed.
 * Uses real system modules (no mocks).
 */

import { detectBrowsers, findBrowser } from "./browser-detector.js";
import { getFreePort } from "./browser-launcher.js";
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

console.log(`\nResults: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
