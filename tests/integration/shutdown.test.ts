// The local web server must always go down. Readiness finding: `saw up` never
// exited on Ctrl-C while the room page was open.
//
// The room page holds a WebSocket. `wss.close()` stops new upgrades, but it
// does not end a socket that is already open, and `server.close()` waits for
// every open connection. So one open page held the process forever. The
// shutdown path removes `.saw/daemon.json` before it waits, so from that first
// press the terminal is stuck, every hook reads no daemon file and no-ops, and
// the page shows stale data.
//
// These tests drive the same close() that `saw up` calls. It must resolve.
import { connect as tcpConnect, type Socket } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  startWeb,
  twoMemberWorkspace,
  type TestWeb,
  type TestWorkspace
} from "./helpers.js";

/** The time close() gets. The forced deadline inside it is shorter. */
const CLOSE_BUDGET_MS = 2500;

/** The subprotocols the room page offers: the run token, then the name. */
function pageProtocols(token: string): string[] {
  return [`saw.token.${token}`, "saw"];
}

/**
 * Open a socket the way the room page does, and wait for the snapshot frame.
 * The frame proves the server holds a live connection, which is the state that
 * used to wedge the shutdown.
 */
function openRoomSocket(web: TestWeb): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const url = `ws://127.0.0.1:${web.port}/ws`;
    const socket = new WebSocket(url, pageProtocols(web.token), { origin: web.url });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("the room socket did not open"));
    }, 5000);
    socket.once("error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("message", () => {
      clearTimeout(timer);
      resolve(socket);
    });
  });
}

/** Report "closed" when the work finishes in time, "hung" when it does not. */
async function within(work: Promise<void>, ms: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve("hung"), ms);
  });
  const result = await Promise.race([work.then(() => "closed"), deadline]);
  clearTimeout(timer);
  return result;
}

/** Is the port down? A closed server refuses the next connection. */
async function portRefuses(web: TestWeb): Promise<boolean> {
  try {
    await fetch(`${web.url}/api/status`, {
      headers: { authorization: `Bearer ${web.token}` }
    });
    return false;
  } catch {
    return true;
  }
}

describe("the web server closes while the room page is open", () => {
  let ws: TestWorkspace;
  /** Everything the test opened. It is released even when an expect fails. */
  let opened: { close(): void }[] = [];

  beforeAll(async () => {
    ws = await twoMemberWorkspace();
  });

  afterEach(() => {
    opened.forEach((item) => item.close());
    opened = [];
  });

  afterAll(async () => {
    await ws.close();
  });

  it("resolves close() while a live room socket holds the server", async () => {
    const web = await startWeb(ws.bob);
    const socket = await openRoomSocket(web);
    opened.push({ close: () => socket.terminate() });
    expect(socket.readyState).toBe(WebSocket.OPEN);

    const started = Date.now();
    // Before the fix this never settles: the open socket blocks server.close().
    expect(await within(web.close(), CLOSE_BUDGET_MS)).toBe("closed");
    expect(Date.now() - started).toBeLessThan(CLOSE_BUDGET_MS);

    // The server is really down, so the next `saw up` can take the port.
    expect(await portRefuses(web)).toBe(true);
  });

  it("resolves close() when a wedged connection never finishes its request", async () => {
    const web = await startWeb(ws.bob);
    // A half-sent request: the headers never end, so the server keeps reading
    // and the connection is not idle. close() must not wait for it, whether it
    // drops the connection itself or the forced deadline does.
    const wedged = await new Promise<Socket>((resolve, reject) => {
      const socket = tcpConnect(web.port, "127.0.0.1", () => {
        socket.write("GET /api/status HTTP/1.1\r\nhost: 127.0.0.1\r\n");
        resolve(socket);
      });
      socket.once("error", reject);
    });
    opened.push({ close: () => wedged.destroy() });

    const started = Date.now();
    expect(await within(web.close(), CLOSE_BUDGET_MS)).toBe("closed");
    expect(Date.now() - started).toBeLessThan(CLOSE_BUDGET_MS);
    expect(await portRefuses(web)).toBe(true);
  });

  it("resolves close() with no client at all, and again on a second call", async () => {
    const web = await startWeb(ws.bob);
    expect(await within(web.close(), CLOSE_BUDGET_MS)).toBe("closed");
    // `saw up` must not hang when a signal arrives twice.
    expect(await within(web.close(), CLOSE_BUDGET_MS)).toBe("closed");
  });

  it("leaves the daemon usable, so the peer still sees the member", async () => {
    // Closing the web surface must not take the relay client down with it.
    // Only `saw up` stops the daemon, and it does that itself.
    const posted = await ws.bob.daemon.post(
      { type: "status", body: "The daemon lives after the web server closes.", refs: [] },
      "human"
    );
    expect(posted.ok).toBe(true);
  });
});
