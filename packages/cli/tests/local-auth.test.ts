// Unit tests for the local surface checks (T057).
// The integration tests drive a real server. These cover the decision rules
// one at a time, including the forms that only a browser produces.
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import {
  checkApiRequest,
  checkStaticRequest,
  checkWebSocketUpgrade,
  generateLocalToken,
  isOwnOrigin,
  tokensMatch,
  type LocalAuth
} from "../src/daemon/local-auth.js";

const TOKEN = "run-token-for-the-test";
const AUTH: LocalAuth = { token: TOKEN, port: 7420 };

/** The smallest request shape the checks read. */
function request(
  method: string,
  headers: Record<string, string | undefined>
): IncomingMessage {
  return { method, headers } as unknown as IncomingMessage;
}

const GOOD = { authorization: `Bearer ${TOKEN}` };

describe("generateLocalToken", () => {
  it("makes a long token of characters that need no escaping", () => {
    const token = generateLocalToken();
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("makes a different token for each run", () => {
    expect(generateLocalToken()).not.toBe(generateLocalToken());
  });
});

describe("tokensMatch", () => {
  it("accepts the same token and refuses anything else", () => {
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true);
    expect(tokensMatch("", TOKEN)).toBe(false);
    expect(tokensMatch(TOKEN + "x", TOKEN)).toBe(false);
    expect(tokensMatch(TOKEN.toUpperCase(), TOKEN)).toBe(false);
  });
});

describe("isOwnOrigin", () => {
  it("accepts the three names of the server's own address", () => {
    expect(isOwnOrigin("http://localhost:7420", 7420)).toBe(true);
    expect(isOwnOrigin("http://127.0.0.1:7420", 7420)).toBe(true);
    expect(isOwnOrigin("http://[::1]:7420", 7420)).toBe(true);
  });

  it("refuses another site, another port, and a page with no origin", () => {
    expect(isOwnOrigin("http://evil.example", 7420)).toBe(false);
    expect(isOwnOrigin("https://localhost:7420", 7420)).toBe(false);
    // Another local server is another attacker. The port must match.
    expect(isOwnOrigin("http://localhost:3000", 7420)).toBe(false);
    expect(isOwnOrigin("null", 7420)).toBe(false);
    expect(isOwnOrigin("http://127.0.0.1.evil.example:7420", 7420)).toBe(false);
  });
});

describe("checkApiRequest", () => {
  it("accepts a call that has the token and no browser context", () => {
    expect(checkApiRequest(request("GET", GOOD), AUTH)).toBeUndefined();
  });

  it("accepts the room page, which is same-origin JSON with the token", () => {
    const req = request("POST", {
      ...GOOD,
      origin: "http://localhost:7420",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json"
    });
    expect(checkApiRequest(req, AUTH)).toBeUndefined();
  });

  it("refuses a foreign origin before it looks at the token", () => {
    const req = request("GET", { ...GOOD, origin: "http://evil.example" });
    expect(checkApiRequest(req, AUTH)?.status).toBe(403);
  });

  it("refuses any browser request that is not same-origin", () => {
    for (const site of ["cross-site", "same-site", "none"]) {
      const req = request("GET", { ...GOOD, "sec-fetch-site": site });
      expect(checkApiRequest(req, AUTH)?.status).toBe(403);
    }
  });

  it("refuses a missing token and a token from another run", () => {
    expect(checkApiRequest(request("GET", {}), AUTH)?.status).toBe(401);
    expect(checkApiRequest(request("GET", { authorization: "Bearer other" }), AUTH)?.status).toBe(
      401
    );
  });

  it("refuses a change that is not application/json", () => {
    const form = request("POST", { ...GOOD, "content-type": "text/plain;charset=UTF-8" });
    expect(checkApiRequest(form, AUTH)?.status).toBe(415);
    const none = request("POST", GOOD);
    expect(checkApiRequest(none, AUTH)?.status).toBe(415);
  });

  it("reads a content type that carries parameters", () => {
    const req = request("POST", { ...GOOD, "content-type": "application/json; charset=utf-8" });
    expect(checkApiRequest(req, AUTH)).toBeUndefined();
  });
});

describe("checkWebSocketUpgrade", () => {
  it("accepts the token as a subprotocol, which is how the page sends it", () => {
    const req = request("GET", {
      origin: "http://127.0.0.1:7420",
      "sec-websocket-protocol": `saw.token.${TOKEN}, saw`
    });
    expect(checkWebSocketUpgrade(req, AUTH)).toBeUndefined();
  });

  it("accepts the token as a header, which a hook or a test can send", () => {
    expect(checkWebSocketUpgrade(request("GET", GOOD), AUTH)).toBeUndefined();
  });

  it("refuses a foreign origin, an absent token, and a wrong token", () => {
    const foreign = request("GET", {
      origin: "http://evil.example",
      "sec-websocket-protocol": `saw.token.${TOKEN}, saw`
    });
    expect(checkWebSocketUpgrade(foreign, AUTH)?.status).toBe(403);
    expect(checkWebSocketUpgrade(request("GET", {}), AUTH)?.status).toBe(401);
    const wrong = request("GET", { "sec-websocket-protocol": "saw.token.other, saw" });
    expect(checkWebSocketUpgrade(wrong, AUTH)?.status).toBe(401);
  });
});

describe("checkStaticRequest", () => {
  it("serves the page to a navigation the member starts", () => {
    expect(checkStaticRequest(request("GET", {}))).toBeUndefined();
    expect(checkStaticRequest(request("GET", { "sec-fetch-site": "none" }))).toBeUndefined();
    expect(
      checkStaticRequest(request("GET", { "sec-fetch-site": "same-origin" }))
    ).toBeUndefined();
  });

  it("refuses a load started by a page on another site", () => {
    expect(checkStaticRequest(request("GET", { "sec-fetch-site": "cross-site" }))?.status).toBe(
      403
    );
    expect(checkStaticRequest(request("GET", { "sec-fetch-site": "same-site" }))?.status).toBe(
      403
    );
  });
});
