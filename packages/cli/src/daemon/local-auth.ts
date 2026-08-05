// Authentication for the two local surfaces (T057, FR-021).
//
// A bind to 127.0.0.1 stops other machines. It does not stop the member's own
// browser. Any page the member opens can post a form to the local API, and any
// page can open a WebSocket to it, because a WebSocket is not subject to the
// same-origin policy. So every local caller must prove that the member started
// it for this workspace. The proof covers reads and changes.
//
// The proof is a run token. `saw up` makes a new token for each run and writes
// it into `.saw/daemon.json`, which only the owner may read. Hooks and MCP
// tools already read that file. The room page gets the token inside the HTML
// that the daemon serves, which a page on another origin cannot read.
//
// The policy is fail closed. A caller with no token is refused, and the
// refusal says what the member must do.
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** The subprotocol that carries the token on a WebSocket handshake. */
export const WS_TOKEN_PROTOCOL_PREFIX = "saw.token.";

/** The subprotocol the server selects. Every client must offer it. */
export const WS_PROTOCOL = "saw";

/** The placeholder in the served HTML that the token replaces. */
export const TOKEN_PLACEHOLDER = "__SAW_LOCAL_TOKEN__";

/**
 * What the local server checks a request against.
 * `port` is the port the server listens on. Only that origin is allowed.
 * The server sets `port` again after it binds, because port 0 means "any free
 * port". No request can arrive before the bind, so the value is always right
 * when a check runs.
 */
export interface LocalAuth {
  token: string;
  port: number;
}

/** A refused request: the status, the error code, and the STE reason. */
export interface AuthFailure {
  status: number;
  code: string;
  message: string;
}

/**
 * Make a token for one run.
 * base64url gives 43 characters of `A-Z a-z 0-9 - _`. Those characters are
 * safe in an HTTP header, in a WebSocket subprotocol, and in HTML text, so no
 * caller has to escape the value.
 */
export function generateLocalToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Compare two tokens in constant time. */
export function tokensMatch(given: string, expected: string): boolean {
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/** Is this Origin value the local server's own origin? */
export function isOwnOrigin(origin: string, port: number): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    // "null" and a file: page land here. Both are foreign.
    return false;
  }
  if (url.protocol !== "http:") return false;
  // URL keeps the brackets of an IPv6 host. Remove them before the compare.
  const host = url.hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (!LOCAL_HOSTS.has(host)) return false;
  return url.port === String(port);
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

/** Read the bearer token of a request. Return undefined when there is none. */
export function bearerToken(req: IncomingMessage): string | undefined {
  const header = headerValue(req, "authorization");
  if (!header) return undefined;
  const match = /^bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : undefined;
}

/** Read the token a WebSocket client offered as a subprotocol. */
export function subprotocolToken(req: IncomingMessage): string | undefined {
  const header = headerValue(req, "sec-websocket-protocol");
  if (!header) return undefined;
  for (const part of header.split(",")) {
    const value = part.trim();
    if (value.startsWith(WS_TOKEN_PROTOCOL_PREFIX)) {
      return value.slice(WS_TOKEN_PROTOCOL_PREFIX.length) || undefined;
    }
  }
  return undefined;
}

const FOREIGN: AuthFailure = {
  status: 403,
  code: "forbidden",
  message:
    "this request did not come from the SAW room page. A page on another site " +
    "cannot read or change this workspace."
};

const UNAUTHORIZED: AuthFailure = {
  status: 401,
  code: "unauthorized",
  message:
    "this request has no valid SAW run token. Every run of saw up makes a new " +
    "token. Tools read it from .saw/daemon.json. Start saw up again, then start " +
    "your coding tool again."
};

const WRONG_TYPE: AuthFailure = {
  status: 415,
  code: "unsupported_media_type",
  message: "the content type of this request must be application/json."
};

/**
 * Does this request come from the member's own browser tab of the room page,
 * or from software that did not set a browser origin at all?
 *
 * A browser sets `Sec-Fetch-Site` on every request it makes. Only
 * `same-origin` is the room page. `cross-site`, `same-site`, and `none` (a
 * typed address or a bookmark) are refused. A hook, an MCP tool, or curl sets
 * neither header; the token then decides.
 */
function checkBrowserContext(req: IncomingMessage, auth: LocalAuth): AuthFailure | undefined {
  const site = headerValue(req, "sec-fetch-site");
  if (site !== undefined && site !== "same-origin") return FOREIGN;
  const origin = headerValue(req, "origin");
  if (origin !== undefined && !isOwnOrigin(origin, auth.port)) return FOREIGN;
  return undefined;
}

/**
 * Check one request to the local HTTP API. Return the failure, or undefined
 * when the request may proceed.
 *
 * The content type check is not only tidiness. A cross-origin form POST can
 * send `text/plain` and is not preflighted, so it reaches the server with the
 * member's browser behind it. A request that must be `application/json` is
 * always preflighted, and the preflight has no answer here.
 */
export function checkApiRequest(
  req: IncomingMessage,
  auth: LocalAuth
): AuthFailure | undefined {
  const foreign = checkBrowserContext(req, auth);
  if (foreign) return foreign;

  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    const raw = headerValue(req, "content-type") ?? "";
    const type = (raw.split(";")[0] ?? "").trim().toLowerCase();
    if (type !== "application/json") return WRONG_TYPE;
  }

  const given = bearerToken(req);
  if (!given || !tokensMatch(given, auth.token)) return UNAUTHORIZED;
  return undefined;
}

/**
 * Check one WebSocket handshake.
 *
 * Browser JavaScript cannot set a header on a WebSocket handshake, so the page
 * cannot send `Authorization`. It sends the token as a subprotocol instead of
 * a query parameter: a subprotocol stays out of the request line, so it does
 * not land in an access log, in a `ps` line, or in a shared address. A caller
 * that can set headers, such as a hook or a test, may use `Authorization`.
 */
export function checkWebSocketUpgrade(
  req: IncomingMessage,
  auth: LocalAuth
): AuthFailure | undefined {
  const origin = headerValue(req, "origin");
  if (origin !== undefined && !isOwnOrigin(origin, auth.port)) return FOREIGN;
  const given = subprotocolToken(req) ?? bearerToken(req);
  if (!given || !tokensMatch(given, auth.token)) return UNAUTHORIZED;
  return undefined;
}

/**
 * Check one request for a static file of the room page.
 *
 * The page HTML carries the run token, so it must never load as a subresource
 * of a foreign page. A browser marks such a load `cross-site` or `same-site`.
 * A navigation the member starts is `none` (a typed address or a bookmark) or
 * `same-origin`, and both are allowed.
 */
export function checkStaticRequest(req: IncomingMessage): AuthFailure | undefined {
  const site = headerValue(req, "sec-fetch-site");
  if (site !== undefined && site !== "same-origin" && site !== "none") return FOREIGN;
  return undefined;
}
