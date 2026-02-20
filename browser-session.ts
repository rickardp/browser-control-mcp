/**
 * Browser session abstraction.
 *
 * Provides a unified interface for browser operations across different protocols:
 * - CdpSession: Chrome DevTools Protocol (Chromium browsers)
 * - BidiSession: WebDriver BiDi (Firefox)
 */

import { CdpClient, connectToTarget, getTargets } from "./cdp-client.js";
import { BidiClient } from "./bidi-client.js";
import { ELEMENT_PICKER_JS, getBoundingBoxScript, getRenderedDomScript } from "./dom-scripts.js";
import { getMarkdownScript } from "./turndown-vendor.js";
import { log, logError } from "./log.js";

// ─── BrowserSession interface ───────────────────────────────────────────────

export interface ScreenshotOptions {
  selector?: string;
  format?: "png" | "jpeg";
  clip?: { x: number; y: number; width: number; height: number };
  fullPage?: boolean;
}

export interface FetchOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
}

export interface FetchResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  url: string;
  redirected: boolean;
}

export interface BrowserSession {
  readonly engine: "chromium" | "firefox";

  /** Navigate to a URL. */
  navigate(url: string): Promise<void>;

  /** Evaluate a JavaScript expression synchronously and return the result. */
  evaluate<T = unknown>(expression: string): Promise<T>;

  /** Evaluate a JavaScript expression that returns a Promise. */
  evaluateAsync<T = unknown>(expression: string, timeout?: number): Promise<T>;

  /** Capture a screenshot. Returns base64-encoded image data. */
  screenshot(opts?: ScreenshotOptions): Promise<{ data: string; format: "png" | "jpeg" }>;

  /** Get rendered DOM HTML, optionally with shadow DOM flattened. */
  getRenderedDOM(opts?: { selector?: string; depth?: number }): Promise<string>;

  /** Get page content as Markdown via Turndown.js. */
  getMarkdown(opts?: { selector?: string }): Promise<string>;

  /** Inject element picker and return selection result. */
  selectElement(timeout?: number): Promise<string>;

  /** Execute an HTTP fetch through the browser's network stack. */
  browserFetch(opts: FetchOptions): Promise<string>;

  /** Close this session (disconnect from browser, don't stop it). */
  close(): Promise<void>;
}

// ─── CdpSession ─────────────────────────────────────────────────────────────

export class CdpSession implements BrowserSession {
  readonly engine = "chromium" as const;
  private client: CdpClient | null = null;
  private httpPort: number;

  constructor(httpPort: number) {
    this.httpPort = httpPort;
  }

  /**
   * Connect to the best page target.
   */
  async connect(): Promise<void> {
    const { client } = await connectToTarget(this.httpPort);
    this.client = client;
  }

  private getClient(): CdpClient {
    if (!this.client) throw new Error("CdpSession not connected");
    return this.client;
  }

  async navigate(url: string): Promise<void> {
    await this.getClient().send("Page.navigate", { url });
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = await this.getClient().send("Runtime.evaluate", {
      expression,
      returnByValue: true,
    }) as { result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } };

    if (result.exceptionDetails) {
      const msg = result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.text
        ?? "Evaluation failed";
      throw new Error(msg);
    }

    return result?.result?.value as T;
  }

  async evaluateAsync<T = unknown>(expression: string, timeout = 30000): Promise<T> {
    const result = await this.getClient().send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout,
    }) as { result?: { value?: T }; exceptionDetails?: { text?: string; exception?: { description?: string } } };

    if (result.exceptionDetails) {
      const msg = result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.text
        ?? "Evaluation failed";
      throw new Error(msg);
    }

    return result?.result?.value as T;
  }

  async screenshot(opts: ScreenshotOptions = {}): Promise<{ data: string; format: "png" | "jpeg" }> {
    const format = opts.format ?? "png";
    const client = this.getClient();

    let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
    let captureBeyondViewport = false;

    if (opts.clip) {
      clip = { ...opts.clip, scale: 1 };
    } else if (opts.selector) {
      const boxJson = await this.evaluate<string | null>(getBoundingBoxScript(opts.selector));
      if (!boxJson) {
        throw new Error(`Element not found: ${opts.selector}`);
      }
      const box = JSON.parse(boxJson);
      clip = { ...box, scale: 1 };
    } else if (opts.fullPage) {
      captureBeyondViewport = true;
    }

    const result = await client.send("Page.captureScreenshot", {
      format,
      ...(clip ? { clip } : {}),
      ...(captureBeyondViewport ? { captureBeyondViewport: true } : {}),
    }) as { data?: string };

    if (!result?.data) {
      throw new Error("Screenshot returned no data");
    }

    return { data: result.data, format };
  }

  async getRenderedDOM(opts: { selector?: string; depth?: number } = {}): Promise<string> {
    const script = getRenderedDomScript(opts.selector, opts.depth);
    const html = await this.evaluate<string>(script);
    if (!html) throw new Error("No DOM content returned");
    return html;
  }

  async getMarkdown(opts: { selector?: string } = {}): Promise<string> {
    const script = getMarkdownScript(opts.selector);
    const md = await this.evaluate<string>(script);
    if (!md) throw new Error("No markdown content returned");
    return md;
  }

  async selectElement(timeout = 30000): Promise<string> {
    const result = await this.evaluateAsync<string>(ELEMENT_PICKER_JS, timeout);
    if (!result) throw new Error("Element selection returned no result");
    return result;
  }

  async browserFetch(opts: FetchOptions): Promise<string> {
    const { url, method = "GET", headers = {}, body, timeout = 30000 } = opts;

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error(`Invalid URL: ${url}`);
    }
    const origin = parsedUrl.origin;

    // We need to create a background tab, navigate it to the target origin,
    // then execute fetch from that context. This preserves cookies and bypasses CORS.
    const mainClient = this.getClient();

    // Create a new background tab
    const createResult = await mainClient.send("Target.createTarget", {
      url: "about:blank",
    }) as { targetId: string };
    const targetId = createResult.targetId;

    let fetchClient: CdpClient | undefined;

    try {
      // Find the new target's WebSocket URL
      const targets = await getTargets(this.httpPort);
      const newTarget = targets.find((t) => t.id === targetId);
      if (!newTarget) throw new Error("Failed to find newly created tab");

      // Connect to the new tab
      fetchClient = new CdpClient();
      await fetchClient.connect(newTarget.webSocketDebuggerUrl);

      // Navigate to origin
      await fetchClient.send("Page.enable");

      const navDone = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Navigation to origin timed out after ${timeout}ms`));
        }, timeout);

        fetchClient!.on("Page.frameNavigated", (params: Record<string, unknown>) => {
          const frame = params.frame as { parentId?: string } | undefined;
          if (!frame?.parentId) {
            clearTimeout(timer);
            resolve();
          }
        });
      });

      await fetchClient.send("Page.navigate", { url: `${origin}/` });
      await navDone;

      // Verify origin
      const locationResult = await fetchClient.send("Runtime.evaluate", {
        expression: "window.location.origin",
        returnByValue: true,
      }) as { result?: { value?: string } };

      const actualOrigin = locationResult?.result?.value;
      if (actualOrigin !== origin) {
        throw new Error(
          `Origin ${origin}/ redirected to ${actualOrigin}. ` +
          `Navigate to the target origin first with coordinator_navigate, then retry.`
        );
      }

      await fetchClient.send("Page.stopLoading");

      // Build and execute fetch
      const fetchScript = `(async () => {
  const resp = await fetch(${JSON.stringify(url)}, {
    method: ${JSON.stringify(method)},
    headers: ${JSON.stringify(headers)},
    ${body !== undefined ? `body: ${JSON.stringify(body)},` : ""}
    credentials: 'include',
  });
  const hdrs = {};
  resp.headers.forEach((v, k) => { hdrs[k] = v; });
  return JSON.stringify({
    status: resp.status,
    statusText: resp.statusText,
    headers: hdrs,
    body: await resp.text(),
    url: resp.url,
    redirected: resp.redirected,
  });
})()`;

      const fetchResult = await fetchClient.send("Runtime.evaluate", {
        expression: fetchScript,
        awaitPromise: true,
        returnByValue: true,
        timeout,
      }) as { result?: { value?: string }; exceptionDetails?: { text?: string; exception?: { description?: string } } };

      if (fetchResult.exceptionDetails) {
        const errMsg = fetchResult.exceptionDetails.exception?.description
          ?? fetchResult.exceptionDetails.text
          ?? "Unknown fetch error";
        throw new Error(`Fetch failed: ${errMsg}`);
      }

      const value = fetchResult?.result?.value;
      if (!value) throw new Error("Fetch returned no result");
      return value;
    } finally {
      if (fetchClient) fetchClient.close();
      try {
        await mainClient.send("Target.closeTarget", { targetId });
      } catch {
        // Best-effort cleanup
      }
    }
  }

  async close(): Promise<void> {
    if (this.client) {
      this.client.close();
      this.client = null;
    }
  }
}

// ─── BidiSession ────────────────────────────────────────────────────────────

export class BidiSession implements BrowserSession {
  readonly engine = "firefox" as const;
  private client: BidiClient;
  private contextId: string | null = null;

  constructor(client: BidiClient) {
    this.client = client;
  }

  /**
   * Initialize the session: create or find a browsing context.
   */
  async initialize(): Promise<void> {
    // Get existing browsing contexts
    const tree = await this.client.send("browsingContext.getTree", {}) as {
      contexts: Array<{ context: string; url: string; children: unknown[] }>;
    };

    if (tree.contexts && tree.contexts.length > 0) {
      // Use the first top-level context
      this.contextId = tree.contexts[0].context;
      log(`BiDi: using existing context ${this.contextId}`);
    } else {
      // Create a new context
      const result = await this.client.send("browsingContext.create", {
        type: "tab",
      }) as { context: string };
      this.contextId = result.context;
      log(`BiDi: created new context ${this.contextId}`);
    }
  }

  private getContext(): string {
    if (!this.contextId) throw new Error("BidiSession not initialized");
    return this.contextId;
  }

  async navigate(url: string): Promise<void> {
    await this.client.send("browsingContext.navigate", {
      context: this.getContext(),
      url,
      wait: "complete",
    });
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = await this.client.send("script.evaluate", {
      expression,
      target: { context: this.getContext() },
      awaitPromise: false,
      resultOwnership: "none",
      serializationOptions: { maxDomDepth: 0 },
    }) as { result?: { type: string; value?: unknown }; exceptionDetails?: { text: string } };

    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text);
    }

    return deserializeBidiValue(result.result) as T;
  }

  async evaluateAsync<T = unknown>(expression: string, timeout = 30000): Promise<T> {
    // Wrap in a Promise if not already
    const wrappedExpr = `Promise.resolve((async () => { return ${expression} })())`;

    const result = await this.client.send("script.evaluate", {
      expression: wrappedExpr,
      target: { context: this.getContext() },
      awaitPromise: true,
      resultOwnership: "none",
      serializationOptions: { maxDomDepth: 0 },
    }) as { result?: { type: string; value?: unknown }; exceptionDetails?: { text: string } };

    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text);
    }

    return deserializeBidiValue(result.result) as T;
  }

  async screenshot(opts: ScreenshotOptions = {}): Promise<{ data: string; format: "png" | "jpeg" }> {
    const format = opts.format ?? "png";

    // BiDi screenshot clip uses a different format
    let clip: Record<string, unknown> | undefined;

    if (opts.clip) {
      clip = {
        type: "box",
        x: opts.clip.x,
        y: opts.clip.y,
        width: opts.clip.width,
        height: opts.clip.height,
      };
    } else if (opts.selector) {
      // Get element bounding box via JS evaluation
      const boxJson = await this.evaluate<string | null>(getBoundingBoxScript(opts.selector));
      if (!boxJson) {
        throw new Error(`Element not found: ${opts.selector}`);
      }
      const box = JSON.parse(boxJson);
      clip = {
        type: "box",
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
      };
    }

    const params: Record<string, unknown> = {
      context: this.getContext(),
      format: { type: format === "jpeg" ? "image/jpeg" : "image/png" },
    };

    if (clip) {
      params.clip = clip;
    } else if (opts.fullPage) {
      // BiDi: use "viewport" origin for full page
      params.origin = "document";
    }

    const result = await this.client.send("browsingContext.captureScreenshot", params) as {
      data: string;
    };

    if (!result?.data) {
      throw new Error("Screenshot returned no data");
    }

    return { data: result.data, format };
  }

  async getRenderedDOM(opts: { selector?: string; depth?: number } = {}): Promise<string> {
    const script = getRenderedDomScript(opts.selector, opts.depth);
    const html = await this.evaluate<string>(script);
    if (!html) throw new Error("No DOM content returned");
    return html;
  }

  async getMarkdown(opts: { selector?: string } = {}): Promise<string> {
    const script = getMarkdownScript(opts.selector);
    const md = await this.evaluate<string>(script);
    if (!md) throw new Error("No markdown content returned");
    return md;
  }

  async selectElement(timeout = 30000): Promise<string> {
    const result = await this.evaluateAsync<string>(ELEMENT_PICKER_JS, timeout);
    if (!result) throw new Error("Element selection returned no result");
    return result;
  }

  async browserFetch(opts: FetchOptions): Promise<string> {
    const { url, method = "GET", headers = {}, body, timeout = 30000 } = opts;

    // Firefox BiDi doesn't have Target.createTarget equivalent for isolated tabs.
    // Use the main context but create an about:blank iframe for origin isolation.
    const fetchScript = `(async () => {
  const resp = await fetch(${JSON.stringify(url)}, {
    method: ${JSON.stringify(method)},
    headers: ${JSON.stringify(headers)},
    ${body !== undefined ? `body: ${JSON.stringify(body)},` : ""}
    credentials: 'include',
  });
  const hdrs = {};
  resp.headers.forEach((v, k) => { hdrs[k] = v; });
  return JSON.stringify({
    status: resp.status,
    statusText: resp.statusText,
    headers: hdrs,
    body: await resp.text(),
    url: resp.url,
    redirected: resp.redirected,
  });
})()`;

    const result = await this.evaluateAsync<string>(fetchScript, timeout);
    if (!result) throw new Error("Fetch returned no result");
    return result;
  }

  async close(): Promise<void> {
    this.client.close();
    this.contextId = null;
  }
}

// ─── BiDi value deserialization ─────────────────────────────────────────────

/**
 * Convert BiDi serialized value to a plain JS value.
 * BiDi returns typed objects like { type: "string", value: "..." }
 */
function deserializeBidiValue(result: { type: string; value?: unknown } | undefined): unknown {
  if (!result) return undefined;

  switch (result.type) {
    case "string":
    case "number":
    case "boolean":
      return result.value;
    case "null":
      return null;
    case "undefined":
      return undefined;
    case "bigint":
      return BigInt(result.value as string);
    case "array":
      return (result.value as Array<{ type: string; value?: unknown }>).map(deserializeBidiValue);
    case "object": {
      const obj: Record<string, unknown> = {};
      for (const [key, val] of result.value as Array<[string, { type: string; value?: unknown }]>) {
        obj[key] = deserializeBidiValue(val);
      }
      return obj;
    }
    default:
      // For node, window, regexp, date, map, set, etc. — return the raw value
      return result.value;
  }
}

// ─── Session factory ────────────────────────────────────────────────────────

/**
 * Create a CdpSession connected to the browser at the given CDP HTTP port.
 */
export async function createCdpSession(httpPort: number): Promise<CdpSession> {
  const session = new CdpSession(httpPort);
  await session.connect();
  return session;
}

/**
 * Create a BidiSession connected to the given BiDi WebSocket URL.
 */
export async function createBidiSession(wsUrl: string): Promise<BidiSession> {
  const client = new BidiClient();
  await client.connect(wsUrl);
  const session = new BidiSession(client);
  await session.initialize();
  return session;
}
