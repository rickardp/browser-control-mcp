/**
 * Minimal WebDriver BiDi WebSocket client.
 *
 * Zero dependencies — uses raw Node.js `http.request` with `Connection: Upgrade`
 * for the WebSocket handshake, same pattern as cdp-client.ts.
 *
 * BiDi uses JSON-RPC style messages:
 * - Requests: { id, method, params }
 * - Responses: { id, result } or { id, error: { error, message } }
 * - Events: { type: "event", method, params }
 */

import * as http from "node:http";
import * as crypto from "node:crypto";
import { log, logError } from "./log.js";

// ─── WebSocket frame helpers (shared logic with cdp-client.ts) ──────────────

function encodeTextFrame(payload: string): Buffer {
  const data = Buffer.from(payload, "utf8");
  const mask = crypto.randomBytes(4);
  let header: Buffer;

  if (data.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; // FIN + text
    header[1] = 0x80 | data.length; // MASK + length
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }

  const masked = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) {
    masked[i] = data[i] ^ mask[i % 4];
  }

  return Buffer.concat([header, mask, masked]);
}

interface DecodedFrame {
  opcode: number;
  payload: Buffer;
  bytesConsumed: number;
}

function decodeFrame(buf: Buffer): DecodedFrame | null {
  if (buf.length < 2) return null;

  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let payloadLen = buf[1] & 0x7f;
  let offset = 2;

  if (payloadLen === 126) {
    if (buf.length < 4) return null;
    payloadLen = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buf.length < 10) return null;
    payloadLen = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }

  if (masked) {
    const maskStart = offset;
    offset += 4;
    if (buf.length < offset + payloadLen) return null;
    const payload = Buffer.alloc(payloadLen);
    for (let i = 0; i < payloadLen; i++) {
      payload[i] = buf[offset + i] ^ buf[maskStart + (i % 4)];
    }
    return { opcode, payload, bytesConsumed: offset + payloadLen };
  }

  if (buf.length < offset + payloadLen) return null;
  return {
    opcode,
    payload: buf.subarray(offset, offset + payloadLen),
    bytesConsumed: offset + payloadLen,
  };
}

// ─── BiDi Client ────────────────────────────────────────────────────────────

type EventHandler = (params: Record<string, unknown>) => void;

export class BidiClient {
  private socket: import("node:net").Socket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private eventHandlers = new Map<string, EventHandler[]>();
  private recvBuf = Buffer.alloc(0);

  /**
   * Connect to a BiDi WebSocket endpoint.
   */
  async connect(wsUrl: string): Promise<void> {
    const url = new URL(wsUrl);
    const key = crypto.randomBytes(16).toString("base64");

    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: "GET",
        headers: {
          "Connection": "Upgrade",
          "Upgrade": "websocket",
          "Sec-WebSocket-Key": key,
          "Sec-WebSocket-Version": "13",
        },
      });

      req.on("upgrade", (_res, socket) => {
        this.socket = socket;

        socket.on("data", (chunk: Buffer) => {
          this.recvBuf = Buffer.concat([this.recvBuf, chunk]);
          this.processFrames();
        });

        socket.on("close", () => {
          for (const [, p] of this.pending) {
            p.reject(new Error("BiDi connection closed"));
          }
          this.pending.clear();
          this.socket = null;
        });

        socket.on("error", (err) => {
          logError("BiDi WebSocket error", err);
        });

        resolve();
      });

      req.on("error", reject);

      // Handle non-upgrade response (e.g. 400 Bad Request)
      req.on("response", (res) => {
        reject(new Error(`BiDi upgrade failed with HTTP ${res.statusCode}`));
        res.resume();
      });

      req.end();
    });
  }

  /**
   * Send a BiDi method call and wait for the result.
   */
  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.socket) throw new Error("BiDi client not connected");

    const id = this.nextId++;
    const msg = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`BiDi request ${method} timed out`));
      }, 30000);

      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });

      this.socket!.write(encodeTextFrame(msg));
    });
  }

  /**
   * Register an event handler for a BiDi event method.
   */
  on(event: string, handler: EventHandler): void {
    const handlers = this.eventHandlers.get(event) || [];
    handlers.push(handler);
    this.eventHandlers.set(event, handlers);
  }

  /**
   * Close the connection.
   */
  close(): void {
    if (this.socket) {
      const closeFrame = Buffer.alloc(6);
      closeFrame[0] = 0x88; // FIN + close
      closeFrame[1] = 0x80; // MASK + 0 length
      crypto.randomBytes(4).copy(closeFrame, 2);
      this.socket.write(closeFrame);
      this.socket.end();
      this.socket = null;
    }
  }

  private processFrames(): void {
    while (this.recvBuf.length > 0) {
      const frame = decodeFrame(this.recvBuf);
      if (!frame) break;

      this.recvBuf = this.recvBuf.subarray(frame.bytesConsumed);

      if (frame.opcode === 0x01) {
        // Text frame — BiDi JSON message
        try {
          const msg = JSON.parse(frame.payload.toString("utf8")) as Record<string, unknown>;

          if (msg.id !== undefined && this.pending.has(msg.id as number)) {
            // Response to a command
            const p = this.pending.get(msg.id as number)!;
            this.pending.delete(msg.id as number);

            if (msg.type === "error" || msg.error) {
              const errObj = (msg.error ?? msg) as { error?: string; message?: string };
              p.reject(new Error(`BiDi error: ${errObj.message ?? errObj.error ?? "unknown"}`));
            } else {
              p.resolve(msg.result ?? msg);
            }
          } else if (msg.type === "event" && typeof msg.method === "string") {
            // BiDi event
            const handlers = this.eventHandlers.get(msg.method) || [];
            for (const h of handlers) {
              h((msg.params ?? {}) as Record<string, unknown>);
            }
          }
        } catch (err) {
          logError("Failed to parse BiDi message", err);
        }
      } else if (frame.opcode === 0x08) {
        this.close();
      } else if (frame.opcode === 0x09) {
        // Ping — respond with pong
        if (this.socket) {
          const pong = Buffer.alloc(6);
          pong[0] = 0x8a;
          pong[1] = 0x80;
          crypto.randomBytes(4).copy(pong, 2);
          this.socket.write(pong);
        }
      }
    }
  }
}

// ─── BiDi target discovery ──────────────────────────────────────────────────

/**
 * Discover the BiDi WebSocket URL from Firefox's HTTP endpoint.
 *
 * Firefox with --remote-debugging-port exposes:
 *   GET /json/version → { webSocketDebuggerUrl: "ws://..." }
 *
 * The webSocketDebuggerUrl is the BiDi endpoint.
 */
export async function getBidiWsUrl(httpPort: number): Promise<string> {
  const resp = await fetch(`http://127.0.0.1:${httpPort}/json/version`);
  const info = (await resp.json()) as { webSocketDebuggerUrl?: string };
  if (!info.webSocketDebuggerUrl) {
    throw new Error("Firefox did not expose a BiDi WebSocket URL");
  }
  return info.webSocketDebuggerUrl;
}
