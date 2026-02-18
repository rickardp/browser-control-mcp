import * as net from "node:net";
import { log, logError } from "./log.js";

export type LazyLaunchCallback = () => Promise<number>;

/**
 * TCP reverse proxy for CDP connections.
 *
 * Sits on a stable port and forwards TCP connections to the browser's
 * internal CDP port. When the browser switches (Chrome -> Edge), the
 * proxy port stays the same — child MCPs don't need restarting.
 *
 * Two launch triggers:
 * 1. Lazy: incoming connection when no browser is running
 * 2. Explicit: coordinator_launch_browser tool call
 */
export class CdpProxy {
  private server: net.Server | null = null;
  private backendPort: number | null = null;
  private connections: Set<net.Socket> = new Set();
  private listenPort: number = 0;
  private lazyLaunch: LazyLaunchCallback | null = null;
  private launching = false;
  private launchPromise: Promise<number> | null = null;

  /**
   * Set the callback invoked when a connection arrives and no backend is set.
   * The callback must launch a browser and return its CDP port.
   */
  onLazyLaunch(cb: LazyLaunchCallback): void {
    this.lazyLaunch = cb;
  }

  /**
   * Start the TCP proxy server on the given port.
   */
  async listen(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((clientSocket) => {
        this.handleConnection(clientSocket);
      });

      this.server.on("error", reject);

      this.server.listen(port, "127.0.0.1", () => {
        const addr = this.server!.address() as net.AddressInfo;
        this.listenPort = addr.port;
        log(`CDP proxy listening on port ${this.listenPort}`);
        resolve(this.listenPort);
      });
    });
  }

  /**
   * Update the backend CDP port (after browser launch or switch).
   */
  setBackend(port: number): void {
    this.backendPort = port;
    log(`CDP proxy backend set to port ${port}`);
  }

  /**
   * Clear the backend (browser stopped).
   */
  clearBackend(): void {
    this.backendPort = null;
    log("CDP proxy backend cleared");
  }

  /**
   * Close all active connections (forces child MCP to reconnect).
   */
  closeConnections(): void {
    for (const socket of this.connections) {
      socket.destroy();
    }
    this.connections.clear();
    log("CDP proxy: all connections closed");
  }

  /**
   * Get the port the proxy is listening on.
   */
  getPort(): number {
    return this.listenPort;
  }

  /**
   * Stop the proxy server and close all connections.
   */
  async close(): Promise<void> {
    this.closeConnections();

    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          this.server = null;
          log("CDP proxy closed");
          resolve();
        });
      });
    }
  }

  private async handleConnection(clientSocket: net.Socket): Promise<void> {
    this.connections.add(clientSocket);
    clientSocket.on("close", () => this.connections.delete(clientSocket));

    try {
      // If no backend, try lazy launch
      if (this.backendPort === null) {
        if (!this.lazyLaunch) {
          log("CDP proxy: no backend and no lazy launch callback — rejecting connection");
          clientSocket.destroy();
          return;
        }

        log("CDP proxy: no backend — triggering lazy browser launch");
        const port = await this.triggerLazyLaunch();
        this.backendPort = port;
      }

      // Connect to backend
      const backendSocket = net.createConnection(
        { port: this.backendPort, host: "127.0.0.1" },
        () => {
          log(`CDP proxy: connected to backend on port ${this.backendPort}`);
          // Pipe bidirectionally
          clientSocket.pipe(backendSocket);
          backendSocket.pipe(clientSocket);
        }
      );

      this.connections.add(backendSocket);
      backendSocket.on("close", () => this.connections.delete(backendSocket));

      backendSocket.on("error", (err) => {
        logError("CDP proxy: backend connection error", err);
        clientSocket.destroy();
        this.connections.delete(backendSocket);
      });

      clientSocket.on("error", (err) => {
        logError("CDP proxy: client connection error", err);
        backendSocket.destroy();
        this.connections.delete(clientSocket);
      });
    } catch (err) {
      logError("CDP proxy: failed to handle connection", err);
      clientSocket.destroy();
    }
  }

  /**
   * Ensure only one lazy launch happens at a time.
   */
  private async triggerLazyLaunch(): Promise<number> {
    if (this.launching && this.launchPromise) {
      return this.launchPromise;
    }

    this.launching = true;
    this.launchPromise = this.lazyLaunch!();
    try {
      const port = await this.launchPromise;
      return port;
    } finally {
      this.launching = false;
      this.launchPromise = null;
    }
  }
}
