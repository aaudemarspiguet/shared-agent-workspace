// The relay tunnel end to end on one machine: a host endpoint in front of a
// local HTTP server, a client tunnel dialed by ticket, one request through.
// The test needs outbound network access: the endpoints go online against
// the public iroh infrastructure, exactly as the product does.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import { hostTunnel, isTunnelAddress, displayRelay, openTunnel } from "../src/tunnel.js";

const closers: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const close of closers.reverse()) await close();
});

describe("relay tunnel", () => {
  it("recognizes and shortens tunnel addresses", () => {
    expect(isTunnelAddress("iroh:abc")).toBe(true);
    expect(isTunnelAddress("ws://localhost:8787")).toBe(false);
    const short = displayRelay(`iroh:${"a".repeat(200)}`);
    expect(short.length).toBeLessThan(30);
  });

  it("carries an HTTP request from a member to the host's relay port", async () => {
    const server = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    closers.push(() => new Promise((resolve) => server.close(() => resolve())));

    const keyDir = mkdtempSync(join(tmpdir(), "saw-tunnel-"));
    closers.push(() => rmSync(keyDir, { recursive: true, force: true }));
    const host = await hostTunnel({
      targetHost: "127.0.0.1",
      targetPort: address.port,
      keyFile: join(keyDir, "host.key")
    });
    closers.push(host.close);
    expect(host.address.startsWith("iroh:")).toBe(true);

    const client = await openTunnel(host.address);
    closers.push(client.close);

    const res = await fetch(`${client.urls.http}/health`);
    const body = (await res.json()) as { ok: boolean; path: string };
    expect(body.ok).toBe(true);
    expect(body.path).toBe("/health");
  }, 60_000);
});
