// The developer console's data contract (T147, FR-047).
//
// The console reports connection and tunnel state, this repository's agent
// integration, and the member directory. It draws only from /api/health and
// /api/status, so these assert that both actually carry what the surface
// needs — a console rendering "not read yet" forever is the failure this
// catches, and it is invisible to every other suite.
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { apiGet, startWeb, twoMemberWorkspace, type TestWorkspace } from "./helpers.js";

let workspace: TestWorkspace | null = null;

afterEach(async () => {
  await workspace?.close();
  workspace = null;
});

interface Health {
  ok: boolean;
  member: string;
  relay_connected: boolean;
  workspace: string;
  repo_root: string;
  repo_remote: string;
  branch_prefix: string;
  relay_transport: string;
  log_spool_pending: number;
  integration: {
    settings_path: string;
    settings_readable: boolean;
    ok: boolean;
    hooks: { event: string; wired: boolean; current: boolean }[];
  };
}

describe("the developer console's data (T147)", () => {
  it("serves connection, tunnel and repository state on /api/health", async () => {
    workspace = await twoMemberWorkspace();
    const web = await startWeb(workspace.alice);
    try {
      const res = await apiGet(web, "/api/health");
      expect(res.status).toBe(200);
      const health = res.json as Health;

      expect(health.member).toBe("alice");
      expect(health.relay_connected).toBe(true);
      expect(health.workspace).toBe("itest");
      expect(health.repo_remote).toBe("git@example.com:acme/app.git");
      expect(health.repo_root).toBe(workspace.alice.root);
      // The prefix is the push boundary; the console shows it so a member
      // can see the rule they are held to (FR-040).
      expect(health.branch_prefix).toBe("alice/");
      // These tests use a plain ws:// address, not an iroh ticket.
      expect(health.relay_transport).toBe("direct");
      expect(health.log_spool_pending).toBe(0);
    } finally {
      await web.close();
    }
  });

  it("reports the agent integration as unwired when no hooks are installed", async () => {
    workspace = await twoMemberWorkspace();
    const web = await startWeb(workspace.alice);
    try {
      const health = (await apiGet(web, "/api/health")).json as Health;
      expect(health.integration.hooks).toHaveLength(4);
      expect(health.integration.ok).toBe(false);
      expect(health.integration.hooks.every((h) => !h.wired)).toBe(true);
      expect(health.integration.settings_path).toBe(
        join(workspace!.alice.root, ".claude", "settings.local.json")
      );
    } finally {
      await web.close();
    }
  });

  // A hook left pointing at a checkout that has moved still parses and still
  // looks installed. The console has to be able to say so.
  it("reports a hook wired to another checkout as not current", async () => {
    workspace = await twoMemberWorkspace();
    const root = workspace.alice.root;
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "settings.local.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: "/gone/saw hook session-start" }] }
          ]
        }
      })
    );
    const web = await startWeb(workspace.alice);
    try {
      const health = (await apiGet(web, "/api/health")).json as Health;
      const start = health.integration.hooks.find((h) => h.event === "SessionStart");
      expect(start?.wired).toBe(true);
      expect(start?.current).toBe(false);
      expect(health.integration.ok).toBe(false);
    } finally {
      await web.close();
    }
  });

  it("serves the member directory the console lists, with presence", async () => {
    workspace = await twoMemberWorkspace();
    const web = await startWeb(workspace.alice);
    try {
      const status = (await apiGet(web, "/api/status")).json as {
        me: string;
        members: { github_username: string; online: boolean; paused: boolean }[];
      };
      expect(status.me).toBe("alice");
      expect(status.members.map((m) => m.github_username).sort()).toEqual(["alice", "bob"]);
      expect(status.members.every((m) => typeof m.paused === "boolean")).toBe(true);
    } finally {
      await web.close();
    }
  });
});
