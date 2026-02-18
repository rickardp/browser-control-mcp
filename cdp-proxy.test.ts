import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { EventEmitter } from "node:events";
import { netMock } from "./test-setup.js";

const { CdpProxy } = await import("./cdp-proxy.js");

describe("CdpProxy", () => {
  let connectionHandlers: ((socket: any) => void)[];
  let mockServer: any;

  beforeEach(() => {
    connectionHandlers = [];

    // Clear shared mocks from other test files
    netMock.createServer.mockClear();
    netMock.createConnection.mockClear();

    // Mock net.createServer to capture connection handlers
    netMock.createServer.mockImplementation((onConnection: (socket: any) => void) => {
      connectionHandlers.push(onConnection);
      mockServer = new EventEmitter() as any;
      mockServer.listen = mock((_port: number, _host: string, cb: () => void) => {
        setTimeout(cb, 0);
        return mockServer;
      });
      mockServer.address = mock(() => ({ port: 41837 }));
      mockServer.close = mock((cb: () => void) => {
        cb();
      });
      mockServer.on = mock(function (this: any, event: string, handler: Function) {
        if (event === "error") {
          // store for potential use
        }
        return this;
      });
      return mockServer;
    });

    netMock.createConnection.mockImplementation((_opts: any, cb: () => void) => {
      const socket = new EventEmitter() as any;
      socket.destroy = mock();
      socket.pipe = mock(() => socket);
      setTimeout(() => cb(), 0);
      return socket;
    });
  });

  test("listen starts TCP server on given port", async () => {
    const proxy = new CdpProxy();
    const port = await proxy.listen(0);

    expect(port).toBe(41837);
    expect(netMock.createServer).toHaveBeenCalled();
  });

  test("getPort returns the listening port", async () => {
    const proxy = new CdpProxy();
    await proxy.listen(0);

    expect(proxy.getPort()).toBe(41837);
  });

  test("setBackend updates the backend port", async () => {
    const proxy = new CdpProxy();
    await proxy.listen(0);
    proxy.setBackend(9222);

    // No error — backend is set
    expect(proxy.getPort()).toBe(41837);
  });

  test("clearBackend resets backend", async () => {
    const proxy = new CdpProxy();
    await proxy.listen(0);
    proxy.setBackend(9222);
    proxy.clearBackend();

    // Backend cleared — next connection would trigger lazy launch
    expect(proxy.getPort()).toBe(41837);
  });

  test("close stops server and clears connections", async () => {
    const proxy = new CdpProxy();
    await proxy.listen(0);

    await proxy.close();
    expect(mockServer.close).toHaveBeenCalledTimes(1);
  });

  test("connection with backend set connects to backend", async () => {
    const proxy = new CdpProxy();
    await proxy.listen(0);
    proxy.setBackend(9222);

    // Simulate incoming connection
    const clientSocket = new EventEmitter() as any;
    clientSocket.destroy = mock();
    clientSocket.pipe = mock(() => clientSocket);

    connectionHandlers[0](clientSocket);
    // Allow async to settle
    await new Promise((r) => setTimeout(r, 10));

    expect(netMock.createConnection).toHaveBeenCalled();
    const calls = netMock.createConnection.mock.calls;
    const connectOpts = calls[calls.length - 1][0];
    expect(connectOpts.port).toBe(9222);
    expect(connectOpts.host).toBe("127.0.0.1");
  });

  test("connection without backend triggers lazy launch", async () => {
    const lazyLaunchMock = mock(async () => 9333);

    const proxy = new CdpProxy();
    await proxy.listen(0);
    proxy.onLazyLaunch(lazyLaunchMock);

    // Simulate incoming connection (no backend set)
    const clientSocket = new EventEmitter() as any;
    clientSocket.destroy = mock();
    clientSocket.pipe = mock(() => clientSocket);

    connectionHandlers[0](clientSocket);
    await new Promise((r) => setTimeout(r, 10));

    expect(lazyLaunchMock).toHaveBeenCalledTimes(1);
    // After lazy launch, backend should be set and connection made
    expect(netMock.createConnection).toHaveBeenCalled();
    const calls = netMock.createConnection.mock.calls;
    const connectOpts = calls[calls.length - 1][0];
    expect(connectOpts.port).toBe(9333);
  });

  test("connection without backend and no callback destroys socket", async () => {
    const proxy = new CdpProxy();
    await proxy.listen(0);

    const clientSocket = new EventEmitter() as any;
    clientSocket.destroy = mock();
    clientSocket.pipe = mock(() => clientSocket);

    connectionHandlers[0](clientSocket);
    await new Promise((r) => setTimeout(r, 10));

    expect(clientSocket.destroy).toHaveBeenCalled();
  });

  test("closeConnections destroys all tracked sockets", async () => {
    const proxy = new CdpProxy();
    await proxy.listen(0);
    proxy.setBackend(9222);

    const clientSocket = new EventEmitter() as any;
    clientSocket.destroy = mock();
    clientSocket.pipe = mock(() => clientSocket);

    connectionHandlers[0](clientSocket);
    await new Promise((r) => setTimeout(r, 10));

    proxy.closeConnections();
    expect(clientSocket.destroy).toHaveBeenCalled();
  });

  test("concurrent lazy launches share the same launch", async () => {
    let launchCount = 0;
    const lazyLaunchMock = mock(async () => {
      launchCount++;
      await new Promise((r) => setTimeout(r, 50));
      return 9333;
    });

    const proxy = new CdpProxy();
    await proxy.listen(0);
    proxy.onLazyLaunch(lazyLaunchMock);

    // Simulate two concurrent connections
    const socket1 = new EventEmitter() as any;
    socket1.destroy = mock();
    socket1.pipe = mock(() => socket1);

    const socket2 = new EventEmitter() as any;
    socket2.destroy = mock();
    socket2.pipe = mock(() => socket2);

    connectionHandlers[0](socket1);
    connectionHandlers[0](socket2);

    await new Promise((r) => setTimeout(r, 100));

    // Should only have triggered one launch
    expect(launchCount).toBe(1);
  });
});
