// T052: prove the hashed-token path.
// The store must keep a SHA-256 hash of each member credential, never the
// credential itself. The hashing has been in place since the store was
// built; this file is the test that holds it there.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { RelayStore } from "../src/store.js";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const dir = mkdtempSync(join(tmpdir(), "saw-store-auth-"));

// Each test gets its own database file. A shared file would couple the
// tests through the WAL: one failed test can leave a connection open,
// and that blocks the next close() from checkpointing.
function freshDb(name: string): string {
  return join(dir, `${name}.db`);
}

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("hashed-token verification (T052)", () => {
  it("stores a hash of the creator token, and no column holds the token", () => {
    const dbPath = freshDb("create");
    const store = new RelayStore(dbPath);
    const { workspace, member, token } = store.createWorkspace(
      "t052",
      "https://github.com/example/t052.git",
      "alice"
    );

    // Read the raw row with a second connection. The store API hides
    // token_hash on purpose, so the proof must not go through it.
    const raw = new Database(dbPath, { readonly: true });
    const row = raw
      .prepare("SELECT * FROM members WHERE id = ?")
      .get(member.id) as Record<string, unknown>;
    raw.close();

    expect(row.token_hash).toBe(sha256(token));
    expect(row.token_hash).not.toBe(token);
    for (const [column, value] of Object.entries(row)) {
      if (typeof value === "string") {
        expect(value, `column ${column} must not hold the token`).not.toContain(token);
      }
    }

    // The hash is what authenticates; the token itself never matches a row.
    expect(store.authMember(workspace.id, token)?.id).toBe(member.id);
    expect(store.authMember(workspace.id, sha256(token))).toBeUndefined();
    store.close();
  });

  it("hashes the joined member's token on invite redemption too", () => {
    const dbPath = freshDb("redeem");
    const store = new RelayStore(dbPath);
    const { workspace } = store.createWorkspace(
      "t052-join",
      "https://github.com/example/t052-join.git",
      "alice"
    );
    store.recordInvite("nonce-1", workspace.id, "bob", new Date(Date.now() + 60_000).toISOString());
    const redeemed = store.redeemInvite("nonce-1", workspace.id, "bob");
    if (!redeemed.ok) throw new Error(redeemed.error);

    const raw = new Database(dbPath, { readonly: true });
    const row = raw
      .prepare("SELECT token_hash FROM members WHERE id = ?")
      .get(redeemed.member.id) as { token_hash: string };
    raw.close();

    expect(row.token_hash).toBe(sha256(redeemed.token));
    expect(store.authMember(workspace.id, redeemed.token)?.id).toBe(redeemed.member.id);
    expect(store.authMember(workspace.id, "not-the-token")).toBeUndefined();
    store.close();
  });

  it("keeps the plain token out of the database file entirely", () => {
    // The strongest form of the claim: after a checkpoint, the bytes on
    // disk contain the hash and do not contain the token, in any table.
    const dbPath = freshDb("bytes");
    const store = new RelayStore(dbPath);
    const { token } = store.createWorkspace(
      "t052-bytes",
      "https://github.com/example/t052-bytes.git",
      "carol"
    );
    store.close(); // close() checkpoints WAL into the main file

    const bytes = readFileSync(dbPath).toString("latin1");
    expect(bytes).toContain(sha256(token));
    expect(bytes).not.toContain(token);
  });
});
