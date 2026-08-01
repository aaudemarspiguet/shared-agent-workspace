// Shared harness for the two-member integration tests.
// One in-process relay (SQLite in memory), two member daemons in temp dirs.
// Tests drive the same code paths as saw up: Daemon, local API, web server.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelay, type RelayServer } from "@saw/relay";
import {
  Daemon,
  joinWorkspace,
  mintInvite,
  registerWorkspace,
  startWebServer,
  writeMemberFiles
} from "@saw/cli";

export interface TestMember {
  name: string;
  root: string;
  daemon: Daemon;
}

export interface TestWorkspace {
  relay: RelayServer;
  relayHttp: string;
  relayWs: string;
  workspaceId: string;
  repoRemote: string;
  alice: TestMember;
  bob: TestMember;
  /** Bearer tokens, for tests that speak raw frames to the relay. */
  aliceToken: string;
  bobToken: string;
  /** Stop both daemons, the relay, and remove temp dirs. */
  close(): Promise<void>;
}

export const REPO_REMOTE = "git@example.com:acme/app.git";

/** Wait until a condition holds. Fail loudly on timeout. */
export async function waitFor(
  condition: () => boolean,
  what = "condition",
  timeoutMs = 8000,
  stepMs = 20
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (condition()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** Poll an async producer until it returns a value. Fail loudly on timeout. */
export async function waitForValue<T>(
  produce: () => Promise<T | undefined>,
  what = "value",
  timeoutMs = 8000,
  stepMs = 50
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await produce();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** Create a member dir with .saw files and a connected daemon. */
export async function startMember(
  name: string,
  root: string,
  params: {
    workspaceId: string;
    relayUrl: string;
    token: string;
    members: string[];
  }
): Promise<TestMember> {
  writeMemberFiles(root, {
    workspaceId: params.workspaceId,
    workspaceName: "itest",
    relayUrl: params.relayUrl,
    github: name,
    repoRemote: REPO_REMOTE,
    members: params.members,
    token: params.token
  });
  const daemon = new Daemon({ root, clientName: `itest-${name}` });
  const connected = await daemon.start(6000);
  if (!connected) throw new Error(`daemon for ${name} did not connect`);
  return { name, root, daemon };
}

/**
 * Register a workspace for alice, invite and join bob, connect two daemons.
 */
export async function twoMemberWorkspace(): Promise<TestWorkspace> {
  const relay = await startRelay(":memory:", 0);
  const relayHttp = `http://127.0.0.1:${relay.port}`;
  const relayWs = `ws://127.0.0.1:${relay.port}`;
  const base = mkdtempSync(join(tmpdir(), "saw-itest-"));
  const aliceRoot = join(base, "alice");
  const bobRoot = join(base, "bob");

  const registered = await registerWorkspace(relayHttp, "itest", REPO_REMOTE, "alice");
  if (!registered.ok) throw new Error(`register failed: ${registered.error}`);
  const workspaceId = registered.value.workspace_id;

  const invite = await mintInvite(relayHttp, workspaceId, registered.value.token, "bob", 72);
  if (!invite.ok) throw new Error(`invite failed: ${invite.error}`);
  const joined = await joinWorkspace(relayHttp, invite.value, "bob");
  if (!joined.ok) throw new Error(`join failed: ${joined.error}`);

  const alice = await startMember("alice", aliceRoot, {
    workspaceId,
    relayUrl: relayWs,
    token: registered.value.token,
    members: ["alice"]
  });
  const bob = await startMember("bob", bobRoot, {
    workspaceId,
    relayUrl: relayWs,
    token: joined.value.token,
    members: joined.value.members
  });

  // Both daemons see both members before any scenario starts.
  await waitFor(
    () => alice.daemon.status().members.length === 2 && bob.daemon.status().members.length === 2,
    "both daemons to see both members"
  );

  return {
    relay,
    relayHttp,
    relayWs,
    workspaceId,
    repoRemote: REPO_REMOTE,
    alice,
    bob,
    aliceToken: registered.value.token,
    bobToken: joined.value.token,
    close: async () => {
      alice.daemon.stop();
      bob.daemon.stop();
      // Let both sockets finish the close handshake before the relay goes
      // away. The relay does not handle socket errors on abrupt teardown.
      await new Promise((r) => setTimeout(r, 100));
      await relay.close();
      rmSync(base, { recursive: true, force: true });
    }
  };
}

/** Start the member's web + API server on a free port. */
export async function startWeb(member: TestMember) {
  const web = await startWebServer(member.daemon, 0);
  return {
    port: web.port,
    url: `http://127.0.0.1:${web.port}`,
    close: web.close
  };
}

/** POST JSON to a member's local API. Returns status and parsed body. */
export async function apiPost(
  baseUrl: string,
  path: string,
  body: unknown
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: (await res.json()) as unknown };
}

/** GET JSON from a member's local API. */
export async function apiGet(
  baseUrl: string,
  path: string
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, json: (await res.json()) as unknown };
}
