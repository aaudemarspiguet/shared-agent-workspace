// The local web server (T030).
// It serves the static room page, the /api routes, and a /ws push channel.
// It binds 127.0.0.1 only (T052). The relay never serves this page.
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { Daemon } from "../daemon/daemon.js";
import { handleApiRequest } from "../daemon/local-api.js";

const STATIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "static");

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" }
};

export interface WebServer {
  server: Server;
  port: number;
  close(): Promise<void>;
}

/** Start the web + API server for one daemon. Localhost only. */
export function startWebServer(daemon: Daemon, port: number): Promise<WebServer> {
  const server = createServer((req, res) => {
    void (async () => {
      const handled = await handleApiRequest(daemon, req, res);
      if (handled) return;
      const url = new URL(req.url ?? "/", "http://localhost");
      const entry = STATIC_FILES[url.pathname];
      if (!entry || req.method !== "GET") {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      try {
        const body = readFileSync(join(STATIC_DIR, entry.file));
        res.writeHead(200, { "content-type": entry.type });
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

  const wss = new WebSocketServer({ server, path: "/ws" });
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
      resolve({
        server,
        port: boundPort,
        close: () =>
          new Promise<void>((done) => {
            wss.close();
            server.close(() => done());
          })
      });
    });
  });
}
