// T057 / SC-009 — the local surfaces accept only the member's own software.
//
// A bind to 127.0.0.1 stops other machines. It does not stop the member's own
// browser. These tests act as a page on another site: they send a foreign
// Origin, they send a form-shaped POST, and they open a WebSocket. All of it
// must fail, on reads as well as on changes (FR-021).
//
// The last tests are the regression that matters most. The real callers, an
// MCP tool and a hook, must still work through the authenticated path.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { writeDaemonInfo } from "@saw/cli";
import { daemonRequest } from "../../packages/cli/src/hooks/io.js";
import { createMcpServer } from "../../packages/cli/src/mcp/server.js";
import {
  startWeb,
  twoMemberWorkspace,
  waitFor,
  type TestWeb,
  type TestWorkspace
} from "./helpers.js";

/** The address of a page the member visits while saw up runs. */
const FOREIGN_ORIGIN = "http://evil.example";

interface ErrorBody {
  error?: { code?: string; message?: string };
}

interface SocketAttempt {
  opened: boolean;
  frame?: { kind?: string; messages?: unknown[] };
  /** The subprotocol the server selected. A browser needs one it offered. */
  protocol?: string;
  error?: string;
}

/**
 * Open a WebSocket and report the first frame, or the reason it failed.
 * The `ws` client reports a refused handshake as an error that names the
 * status, because this test attaches no unexpected-response listener.
 */
function tryWebSocket(
  url: string,
  protocols: string[],
  options: { headers?: Record<string, string>; origin?: string } = {}
): Promise<SocketAttempt> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, protocols, options);
    const done = (result: SocketAttempt): void => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.close();
      resolve(result);
    };
    const timer = setTimeout(() => done({ opened: false, error: "timeout" }), 5000);
    socket.once("error", (error: Error) => done({ opened: false, error: error.message }));
    socket.once("message", (data) =>
      done({
        opened: true,
        protocol: socket.protocol,
        frame: JSON.parse(String(data)) as SocketAttempt["frame"]
      })
    );
  });
}

describe("the local surfaces refuse everything but the member's own tools (SC-009)", () => {
  let ws: TestWorkspace;
  let web: TestWeb;
  let wsUrl = "";

  /** The subprotocols the room page offers: the token, then the plain name. */
  function pageProtocols(token: string): string[] {
    return [`saw.token.${token}`, "saw"];
  }

  beforeAll(async () => {
    ws = await twoMemberWorkspace();
    web = await startWeb(ws.bob);
    wsUrl = `ws://127.0.0.1:${web.port}/ws`;
  });

  afterAll(async () => {
    await web.close();
    await ws.close();
  });

  // ---- The HTTP API ----

  it("refuses a read that carries a foreign Origin", async () => {
    const res = await fetch(`${web.url}/api/status`, {
      headers: {
        origin: FOREIGN_ORIGIN,
        "sec-fetch-site": "cross-site",
        authorization: `Bearer ${web.token}`
      }
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorBody;
    expect(body.error?.code).toBe("forbidden");
  });

  it("refuses a change that carries a foreign Origin", async () => {
    const res = await fetch(`${web.url}/api/pause`, {
      method: "POST",
      headers: {
        origin: FOREIGN_ORIGIN,
        "sec-fetch-site": "cross-site",
        "content-type": "application/json",
        authorization: `Bearer ${web.token}`
      },
      body: JSON.stringify({ paused: true })
    });
    expect(res.status).toBe(403);
    expect(ws.bob.daemon.pauseMirror.ownPaused).toBe(false);
  });

  it("refuses a read with no token", async () => {
    const res = await fetch(`${web.url}/api/messages?since_seq=0`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as ErrorBody;
    expect(body.error?.code).toBe("unauthorized");
    // The message tells the member what to do.
    expect(body.error?.message).toContain("saw up");
  });

  it("refuses a change with no token", async () => {
    const res = await fetch(`${web.url}/api/pause`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paused: true })
    });
    expect(res.status).toBe(401);
    expect(ws.bob.daemon.pauseMirror.ownPaused).toBe(false);
  });

  it("refuses a token that is not this run's token", async () => {
    const res = await fetch(`${web.url}/api/status`, {
      headers: { authorization: "Bearer not-the-run-token" }
    });
    expect(res.status).toBe(401);
  });

  it("refuses a form-shaped POST, the cross-site change with no preflight", async () => {
    // This is what <form enctype="text/plain"> sends. The body is valid JSON
    // on purpose. The content type check refuses it before the parser sees it.
    const res = await fetch(`${web.url}/api/pause`, {
      method: "POST",
      headers: {
        "content-type": "text/plain;charset=UTF-8",
        authorization: `Bearer ${web.token}`
      },
      body: JSON.stringify({ paused: true })
    });
    expect(res.status).toBe(415);
    const body = (await res.json()) as ErrorBody;
    expect(body.error?.code).toBe("unsupported_media_type");
    expect(ws.bob.daemon.pauseMirror.ownPaused).toBe(false);
  });

  it("accepts the room page: same origin, the run token, and JSON", async () => {
    const read = await fetch(`${web.url}/api/status`, {
      headers: {
        origin: web.url,
        "sec-fetch-site": "same-origin",
        authorization: `Bearer ${web.token}`
      }
    });
    expect(read.status).toBe(200);
    expect((await read.json()) as { me?: string }).toMatchObject({ me: "bob" });

    const change = await fetch(`${web.url}/api/post`, {
      method: "POST",
      headers: {
        origin: web.url,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
        authorization: `Bearer ${web.token}`
      },
      body: JSON.stringify({
        type: "status",
        body: "The room page speaks for its human.",
        sender_kind: "human"
      })
    });
    expect(change.status).toBe(200);
  });

  // ---- The /ws push channel ----

  it("refuses a socket that carries a foreign Origin", async () => {
    const attempt = await tryWebSocket(wsUrl, pageProtocols(web.token), {
      origin: FOREIGN_ORIGIN
    });
    expect(attempt.opened).toBe(false);
    expect(attempt.error).toContain("403");
  });

  it("refuses a socket with no token, so the room never leaves the machine", async () => {
    const attempt = await tryWebSocket(wsUrl, []);
    expect(attempt.opened).toBe(false);
    expect(attempt.error).toContain("401");
    expect(attempt.frame).toBeUndefined();
  });

  it("refuses a socket that offers a token from another run", async () => {
    const attempt = await tryWebSocket(wsUrl, pageProtocols("not-the-run-token"));
    expect(attempt.opened).toBe(false);
    expect(attempt.error).toContain("401");
  });

  it("accepts the room page socket and sends the snapshot", async () => {
    const attempt = await tryWebSocket(wsUrl, pageProtocols(web.token), {
      origin: web.url
    });
    expect(attempt.opened).toBe(true);
    expect(attempt.frame?.kind).toBe("snapshot");
    expect(Array.isArray(attempt.frame?.messages)).toBe(true);
    // The server selects a name the client offered. A browser closes the
    // socket when the answer names anything else.
    expect(attempt.protocol).toBe("saw");
  });

  it("accepts a socket from a caller that can set headers", async () => {
    const attempt = await tryWebSocket(wsUrl, [], {
      headers: { authorization: `Bearer ${web.token}` }
    });
    expect(attempt.opened).toBe(true);
    expect(attempt.frame?.kind).toBe("snapshot");
  });

  // ---- The served page ----

  it("gives the page the token, and refuses to serve it to a foreign context", async () => {
    const page = await fetch(`${web.url}/`, { headers: { "sec-fetch-site": "none" } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain(`content="${web.token}"`);
    expect(html).not.toContain("__SAW_LOCAL_TOKEN__");
    expect(page.headers.get("x-frame-options")).toBe("DENY");

    // A foreign page that loads the room page as a script or a frame gets
    // nothing, so the token stays inside the member's own tab.
    const embedded = await fetch(`${web.url}/`, {
      headers: { "sec-fetch-site": "cross-site", origin: FOREIGN_ORIGIN }
    });
    expect(embedded.status).toBe(403);
  });
});

describe("the real callers still work through the authenticated path (T057)", () => {
  let ws: TestWorkspace;
  let web: TestWeb;

  /** Write .saw/daemon.json as `saw up` does. Hooks and MCP tools read it. */
  function writeDaemonFile(token?: string): void {
    writeDaemonInfo(ws.bob.root, {
      port: web.port,
      pid: process.pid,
      started_at: new Date().toISOString(),
      token
    });
  }

  async function mcpClient(): Promise<Client> {
    const server = createMcpServer(ws.bob.root);
    const client = new Client({ name: "t057-itest", version: "0.1.0" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    await client.connect(clientSide);
    return client;
  }

  /** The text of a tool answer, with the error flag the contract uses. */
  async function callTool(
    client: Client,
    name: string,
    args: Record<string, unknown>
  ): Promise<{ isError: boolean; text: string }> {
    const result = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    return { isError: result.isError === true, text: result.content[0]?.text ?? "" };
  }

  beforeAll(async () => {
    ws = await twoMemberWorkspace();
    web = await startWeb(ws.bob);
    writeDaemonFile(web.token);
  });

  afterAll(async () => {
    await web.close();
    await ws.close();
  });

  it("answers an MCP read and an MCP post", async () => {
    const client = await mcpClient();
    const status = await callTool(client, "workspace_status", {});
    expect(status.isError).toBe(false);
    expect((JSON.parse(status.text) as { me: string }).me).toBe("bob");

    const posted = await callTool(client, "room_post", {
      type: "status",
      body: "The MCP tool posts through the authenticated path."
    });
    expect(posted.isError).toBe(false);
    await waitFor(
      () =>
        ws.alice.daemon
          .messages(0)
          .messages.some((m) => m.body.startsWith("The MCP tool posts")),
      "alice to receive the post of bob's MCP tool"
    );
    await client.close();
  });

  it("answers a hook injection and its acknowledgement", async () => {
    const post = await ws.alice.daemon.post(
      { type: "status", body: "A message for the hook to inject.", refs: [] },
      "agent"
    );
    expect(post.ok).toBe(true);
    await waitFor(
      () => ws.bob.daemon.messages(0).messages.some((m) => m.body.startsWith("A message for")),
      "bob's daemon to receive the message"
    );

    // The same two calls the SessionStart and UserPromptSubmit hooks make.
    const injected = (await daemonRequest(
      "/api/inject",
      { method: "POST", body: { source: "prompt-submit", prompt: "continue" } },
      3000,
      ws.bob.root
    )) as { messages: { body: string }[]; ack_seq: number } | undefined;
    expect(injected).toBeDefined();
    expect(injected?.messages.some((m) => m.body.startsWith("A message for"))).toBe(true);

    const acked = await daemonRequest(
      "/api/inject/ack",
      { method: "POST", body: { seq: injected?.ack_seq, notices: 0 } },
      3000,
      ws.bob.root
    );
    expect(acked).toBeDefined();
    expect(ws.bob.daemon.cursor.value).toBe(injected?.ack_seq);
  });

  it("fails closed when the daemon file holds no token, and says what to do", async () => {
    writeDaemonFile(undefined);
    try {
      // A hook stays silent, exactly as it does when the daemon is down. A
      // hook must never break the member's coding tool.
      const quiet = await daemonRequest("/api/pause", undefined, 2000, ws.bob.root);
      expect(quiet).toBeUndefined();

      // An MCP tool reports the reason, so the member reads what to do.
      const client = await mcpClient();
      const status = await callTool(client, "workspace_status", {});
      expect(status.isError).toBe(true);
      expect(status.text).toContain("daemon.json");
      expect(status.text).toContain("saw up");
      await client.close();
    } finally {
      writeDaemonFile(web.token);
    }
  });
});
