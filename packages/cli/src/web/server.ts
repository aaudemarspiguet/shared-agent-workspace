// The local web server (T030).
// It serves the static room page, the /api routes, and a /ws push channel.
// It binds 127.0.0.1 only (T052). The relay never serves this page.
//
// Both surfaces need the run token (T057). The page gets the token once, in
// the HTML the server sends it. A page on another origin cannot read that
// HTML, cannot read an /api answer, and cannot open /ws.
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { Daemon } from "../daemon/daemon.js";
import { handleApiRequest } from "../daemon/local-api.js";
import {
  checkStaticRequest,
  checkWebSocketUpgrade,
  TOKEN_PLACEHOLDER,
  WS_PROTOCOL,
  type LocalAuth
} from "../daemon/local-auth.js";

const STATIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "static");

/**
 * How long close() waits for the connections to go down on their own.
 * After this it drops them all and returns. Ctrl-C is one press, so the
 * member must never wait for a socket that does not answer.
 */
const CLOSE_DEADLINE_MS = 1000;

const STATIC_FILES: Record<string, { file: string; type: string; token?: boolean }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8", token: true },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" }
};

export interface WebServer {
  server: Server;
  port: number;
  /** The run token the page and every other local caller must present. */
  token: string;
  /** Stop the server and every connection it holds. This always resolves. */
  close(): Promise<void>;
}

/**
 * Headers for every static answer.
 * `frame-ancestors` and X-Frame-Options stop a foreign page from framing the
 * room page to reach the token. `nosniff` stops the HTML being read as a
 * script. `no-store` keeps the token out of the browser cache.
 *
 * A foreign page may still open the room page in a new tab: that is a top
 * level navigation, which browsers mark `Sec-Fetch-Site: none`, and the room
 * page must keep working when the member opens it themselves. The opened page
 * carries the token, so `Cross-Origin-Opener-Policy` cuts the link to the
 * opener. The opener then holds no window reference and cannot reach the page
 * through `window.opener` or `postMessage`, even if this page later gains code
 * that talks to its opener.
 */
function staticHeaders(type: string, port: number): Record<string, string> {
  return {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "content-security-policy":
      "default-src 'self'; " +
      `connect-src 'self' ws://localhost:${port} ws://127.0.0.1:${port}; ` +
      "img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; object-src 'none'"
  };
}

/**
 * Stop the server and every connection it holds. Always resolve.
 *
 * `wss.close()` only stops new upgrades. It does not end a socket that is
 * already open, and `server.close()` waits for every open connection. So one
 * open room page held `saw up` forever: the terminal never came back, and the
 * caller had already removed the daemon file. Every live socket therefore goes
 * down first, and idle connections go with it.
 *
 * The deadline is the last guard. When a connection does not go down, the
 * server drops all of them and this promise resolves anyway. A caller may call
 * close() again; the second call resolves too.
 */
function closeWebServer(server: Server, wss: WebSocketServer): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve();
    };
    const deadline = setTimeout(() => {
      server.closeAllConnections();
      finish();
    }, CLOSE_DEADLINE_MS);
    // The timer must not keep the process alive by itself.
    deadline.unref();

    // End the live room sockets. This also runs each `close` handler, which
    // unsubscribes the socket from the daemon.
    for (const client of wss.clients) client.terminate();
    wss.close();
    // `server.close()` reports an error when the server is already down. The
    // callback still runs, so a second close() resolves as well.
    server.close(() => finish());
    // A browser keeps an idle connection for the next request. Drop it, or
    // the close above waits for the keep-alive timeout.
    server.closeIdleConnections();
  });
}

/** Start the web + API server for one daemon. Localhost only. */
export function startWebServer(daemon: Daemon, port: number): Promise<WebServer> {
  // `port` may be 0, which means "any free port". The listen callback below
  // sets the real port before any request can arrive.
  const auth: LocalAuth = { token: daemon.localToken, port };

  const server = createServer((req, res) => {
    void (async () => {
      const handled = await handleApiRequest(daemon, req, res, auth);
      if (handled) return;
      const url = new URL(req.url ?? "/", "http://localhost");
      const entry = STATIC_FILES[url.pathname];
      if (!entry || req.method !== "GET") {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      const failure = checkStaticRequest(req);
      if (failure) {
        res.writeHead(failure.status, { "content-type": "text/plain" });
        res.end(failure.message);
        return;
      }
      try {
        const raw = readFileSync(join(STATIC_DIR, entry.file));
        // The token is base64url, so it needs no escaping in the HTML.
        const body = entry.token
          ? raw.toString("utf8").replace(TOKEN_PLACEHOLDER, auth.token)
          : raw;
        res.writeHead(200, staticHeaders(entry.type, auth.port));
        res.end(body);
      } catch {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("static file missing");
      }
    })().catch(() => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("server error");
    });
  });

  const wss = new WebSocketServer({
    server,
    path: "/ws",
    verifyClient: (info, done) => {
      const failure = checkWebSocketUpgrade(info.req, auth);
      if (failure) done(false, failure.status, failure.message);
      else done(true);
    },
    // The client offers two subprotocols: the token, and "saw". The server
    // selects "saw", because a browser closes a socket when the server
    // answers with a subprotocol the client did not offer.
    handleProtocols: (protocols) => (protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false)
  });
  wss.on("connection", (ws: WebSocket) => {
    ws.send(
      JSON.stringify({
        kind: "snapshot",
        status: daemon.status(),
        messages: daemon.messages(0, 500).messages,
        notices: daemon.state.recentClaimNotices(20)
      })
    );
    const unsubscribe = daemon.subscribe((event) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ kind: "event", event, status: daemon.status() }));
      }
    });
    ws.on("close", unsubscribe);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : port;
      auth.port = boundPort;
      resolve({
        server,
        port: boundPort,
        token: auth.token,
        close: () => closeWebServer(server, wss)
      });
    });
  });
}
