// The relay tunnel (spec 002, US1 slice): reach the relay with zero network
// configuration. The host member runs `saw share-relay`. It listens on an
// iroh endpoint and pipes each stream to the relay's TCP port. Other members
// put the printed `iroh:<ticket>` address in .saw/config.json. Their side
// dials the ticket and serves the relay on a local loopback port. The relay
// itself does not change. Only bytes of the existing protocol cross.
//
// iroh gives NAT holepunching with a public-relay fallback, and a stable
// address: the ticket names the host's public key, not an IP. The key file
// on the host machine keeps the address stable across restarts.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import net from "node:net";
import { createRequire } from "node:module";
import type { Socket } from "node:net";
import type { BiStream, Connection } from "@number0/iroh";

// The published @number0/iroh package has a broken "main" field. Node's
// require falls back to the real entry file; bundlers refuse. Load it at
// runtime so every context (tsx, vitest, a future bundle) takes Node's path.
const { Endpoint, EndpointTicket, SecretKey } =
  createRequire(import.meta.url)("@number0/iroh") as typeof import("@number0/iroh");
import type { RelayUrls } from "./relay-http.js";

/** The protocol name both sides expect on a tunnel connection. */
const ALPN = Array.from(Buffer.from("saw-relay-tunnel/1"));

/** How long a dial may take before the member gets an error. */
const DIAL_TIMEOUT_MS = 20_000;

/**
 * The endpoint driver stops when its JS object is collected. Every live
 * endpoint and connection must stay referenced here until close.
 */
const KEEP = new Set<unknown>();

/** True when the relay address is a tunnel ticket, not a direct URL. */
export function isTunnelAddress(relay: string): boolean {
  return relay.startsWith("iroh:");
}

/** The ticket inside an `iroh:` or `iroh://` address. */
function ticketOf(relay: string): string {
  return relay.replace(/^iroh:\/\//, "iroh:").slice("iroh:".length);
}

/** A short display form of a relay address. Tickets are long. */
export function displayRelay(relay: string): string {
  if (!isTunnelAddress(relay)) return relay;
  const ticket = ticketOf(relay);
  return `iroh:${ticket.slice(0, 12)}…${ticket.slice(-6)}`;
}

async function withTimeout<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const wait = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out`)), DIAL_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, wait]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pipe one TCP socket and one tunnel stream into each other, both ways.
 * TCP-to-tunnel writes are serialized: the socket pauses until the tunnel
 * accepts each chunk. Tunnel-to-TCP writes wait for the socket to drain.
 */
function pipe(sock: Socket, bi: BiStream): void {
  sock.on("error", () => {});
  sock.on("data", (chunk: Buffer) => {
    sock.pause();
    bi.send.writeAll(Array.from(chunk)).then(
      () => sock.resume(),
      () => sock.destroy()
    );
  });
  sock.on("end", () => {
    bi.send.finish().catch(() => {});
  });
  void (async () => {
    try {
      for (;;) {
        const chunk = await bi.recv.read(65536);
        if (!chunk || chunk.length === 0) break;
        if (!sock.write(Buffer.from(chunk))) {
          await new Promise<void>((resolve) => sock.once("drain", resolve));
        }
      }
    } catch {
      // A dropped tunnel ends the socket below.
    } finally {
      sock.end();
    }
  })();
}

/** Read the host key, or create it. The key is the host's stable identity. */
function loadOrCreateKey(keyFile: string): number[] {
  try {
    const bytes = readFileSync(keyFile);
    if (bytes.length === 32) return Array.from(bytes);
  } catch {
    // No key yet. Create one below.
  }
  const key = SecretKey.generate().toBytes();
  mkdirSync(dirname(keyFile), { recursive: true });
  writeFileSync(keyFile, Buffer.from(key), { mode: 0o600 });
  return key;
}

export interface HostTunnel {
  /** The address other members put in .saw/config.json. */
  address: string;
  /** The host endpoint's public key, short form, for log lines. */
  shortId: string;
  close: () => Promise<void>;
}

/**
 * Host side. Accept tunnel connections and pipe each stream to the relay's
 * TCP port. Runs until closed. The key file keeps the address stable.
 */
export async function hostTunnel(options: {
  targetHost: string;
  targetPort: number;
  keyFile: string;
}): Promise<HostTunnel> {
  const endpoint = await Endpoint.bind({
    secretKey: loadOrCreateKey(options.keyFile),
    alpns: [ALPN]
  });
  KEEP.add(endpoint);
  await withTimeout(endpoint.online(), "going online");
  const ticket = EndpointTicket.fromAddr(endpoint.addr()).toString();

  let open = true;
  void (async () => {
    while (open) {
      const incoming = await endpoint.acceptNext().catch(() => null);
      if (!incoming) break;
      void (async () => {
        const conn = await (await incoming.accept()).connect();
        KEEP.add(conn);
        try {
          for (;;) {
            const bi = await conn.acceptBi().catch(() => null);
            if (!bi) break;
            const sock = net.connect(options.targetPort, options.targetHost);
            sock.on("error", () => {});
            const up = await new Promise<boolean>((resolve) => {
              sock.once("connect", () => resolve(true));
              sock.once("error", () => resolve(false));
            });
            if (!up) {
              bi.send.reset(1n).catch(() => {});
              continue;
            }
            pipe(sock, bi);
          }
        } finally {
          KEEP.delete(conn);
        }
      })().catch(() => {});
    }
  })();

  return {
    address: `iroh:${ticket}`,
    shortId: endpoint.id().fmtShort(),
    close: async () => {
      open = false;
      KEEP.delete(endpoint);
    }
  };
}

export interface ClientTunnel {
  /** The relay's faces on this machine, served by the tunnel. */
  urls: RelayUrls;
  close: () => Promise<void>;
}

/**
 * Member side. Serve the relay on a local loopback port. Each local
 * connection becomes one tunnel stream to the host. A dropped tunnel
 * connection re-dials on the next local connection, so the daemon's own
 * reconnect loop drives recovery.
 */
export async function openTunnel(relayAddress: string): Promise<ClientTunnel> {
  const ticket = EndpointTicket.fromString(ticketOf(relayAddress));
  const endpoint = await Endpoint.bind({});
  KEEP.add(endpoint);

  let conn: Connection | undefined;
  const dial = async (): Promise<Connection> => {
    if (conn && conn.closeReason() === null) return conn;
    if (conn) KEEP.delete(conn);
    conn = await withTimeout(
      endpoint.connect(ticket.endpointAddr(), ALPN),
      "reaching the relay host"
    );
    KEEP.add(conn);
    return conn;
  };
  // Fail fast on a wrong ticket or an offline host, before any caller waits.
  await dial();

  const server = net.createServer((sock) => {
    sock.on("error", () => {});
    void dial()
      .then((c) => c.openBi())
      .then((bi) => pipe(sock, bi))
      .catch(() => sock.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the tunnel could not open a local port");
  }
  const port = address.port;

  return {
    urls: {
      http: `http://127.0.0.1:${port}`,
      ws: `ws://127.0.0.1:${port}/ws`
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (conn) KEEP.delete(conn);
      KEEP.delete(endpoint);
    }
  };
}

export interface ResolvedRelay {
  urls: RelayUrls;
  /** No-op for a direct URL. Closes the tunnel for a ticket address. */
  close: () => Promise<void>;
}

/**
 * Turn a relay address from .saw/config.json into reachable URLs. A direct
 * ws:// or http:// URL passes through. An `iroh:` ticket opens a tunnel.
 * Every command that talks to the relay resolves through here.
 */
export async function resolveRelay(relay: string): Promise<ResolvedRelay> {
  if (!isTunnelAddress(relay)) {
    const { relayUrls } = await import("./relay-http.js");
    return { urls: relayUrls(relay), close: async () => {} };
  }
  try {
    const tunnel = await openTunnel(relay);
    return { urls: tunnel.urls, close: tunnel.close };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `the relay host is not reachable over the tunnel (${reason}). ` +
        "The host member must have `saw share-relay` running."
    );
  }
}
