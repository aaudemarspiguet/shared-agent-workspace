// T044 — User Story 3: the automatic work log.
// Maps to quickstart.md Scenario 3 (FR-015/016, SC-003).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { twoMemberWorkspace, waitFor, waitForValue, type TestWorkspace } from "./helpers.js";

/** True when the value is one canonical ISO timestamp string. */
function isIsoString(value: string): boolean {
  const time = Date.parse(value);
  return !Number.isNaN(time) && new Date(time).toISOString() === value;
}

describe("automatic work log (US3)", () => {
  let ws: TestWorkspace;

  beforeAll(async () => {
    ws = await twoMemberWorkspace();
  });

  afterAll(async () => {
    await ws.close();
  });

  it("a simulated run produces one complete entry with zero manual steps (SC-003)", async () => {
    // The agent claims the item, gets a prompt, works, and stops.
    // No step below writes the log by hand.
    const posted = await ws.alice.daemon.post(
      { type: "intent", body: "Taking the API endpoints.", work_item: "api-endpoints" },
      "agent"
    );
    expect(posted.ok).toBe(true);
    await waitFor(
      () =>
        ws.alice.daemon
          .status()
          .work_items.some(
            (w) => w.feature_tag === "api-endpoints" && w.claimed_by === "alice"
          ),
      "alice's mirror to show her claim"
    );

    ws.alice.daemon.inject("prompt-submit", "Build the API endpoints");
    const appended = await ws.alice.daemon.runStop({
      tools_used: { Edit: 12, Bash: 4 },
      branch: "alice/api",
      head: "d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5",
      files_changed: 7
    });
    expect(appended.ok).toBe(true);

    const entry = await waitForValue(async () => {
      const result = await ws.alice.daemon.log({ member: "me", work_item: "api-endpoints" });
      return result.entries[0];
    }, "alice's run to appear in the work log");

    expect(entry.member).toBe("alice");
    // The when: hook timestamps, start before end.
    expect(isIsoString(entry.started_at)).toBe(true);
    expect(isIsoString(entry.ended_at)).toBe(true);
    expect(entry.started_at <= entry.ended_at).toBe(true);
    // The what: counts and git refs only.
    expect(entry.what.tools_used.Edit).toBe(12);
    expect(entry.what.branch).toBe("alice/api");
    expect(entry.what.head).toBe("d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5");
    expect(entry.what.files_changed).toBe(7);
    // The why: the prompt that started the run.
    expect(entry.why_trigger).toContain("Build the API endpoints");
    // The feature: the claim that was active at run time.
    expect(entry.work_item).toBe("api-endpoints");
    expect(entry.source).toBe("hook_stop");
  });

  it("boundary rejections appear in the log without the payload", async () => {
    const posted = await ws.alice.daemon.post(
      { type: "status", body: "--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@" },
      "agent"
    );
    expect(posted.ok).toBe(false);
    if (!posted.ok) expect(posted.message).toContain("content_smuggling");

    const entry = await waitForValue(async () => {
      const result = await ws.alice.daemon.log({ member: "me" });
      return result.entries.find((e) => e.source === "boundary_rejection");
    }, "the rejection to appear in the work log");
    // The log names the reason. It never echoes the rejected body.
    expect(entry.why_trigger).toContain("unified diff markers");
    expect(entry.why_trigger).not.toContain("src/x.ts");
  });

  it("the feature filter returns only tagged entries", async () => {
    const claimed = await ws.bob.daemon.post(
      { type: "intent", body: "Taking the web UI.", work_item: "web-ui" },
      "agent"
    );
    expect(claimed.ok).toBe(true);
    await waitFor(
      () =>
        ws.bob.daemon
          .status()
          .work_items.some((w) => w.feature_tag === "web-ui" && w.claimed_by === "bob"),
      "bob's mirror to show his claim"
    );
    ws.bob.daemon.inject("prompt-submit", "Style the web UI");
    const appended = await ws.bob.daemon.runStop({ tools_used: { Write: 3 } });
    expect(appended.ok).toBe(true);

    await waitForValue(async () => {
      const result = await ws.alice.daemon.log({ member: "any" });
      const tags = result.entries.map((e) => e.work_item);
      const bothVisible = tags.includes("api-endpoints") && tags.includes("web-ui");
      return bothVisible ? result.entries : undefined;
    }, "both runs to be visible in the shared log");

    const api = await ws.alice.daemon.log({ work_item: "api-endpoints" });
    expect(api.entries.length).toBeGreaterThan(0);
    expect(api.entries.every((e) => e.work_item === "api-endpoints")).toBe(true);

    const web = await ws.alice.daemon.log({ work_item: "web-ui" });
    expect(web.entries.length).toBeGreaterThan(0);
    expect(web.entries.every((e) => e.work_item === "web-ui")).toBe(true);

    // From alice's side, "peer" means bob and nobody else.
    const peer = await ws.alice.daemon.log({ member: "peer" });
    expect(peer.entries.length).toBeGreaterThan(0);
    expect(peer.entries.every((e) => e.member === "bob")).toBe(true);
  });

  it("the since filter cuts old entries", async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const result = await ws.alice.daemon.log({ since: future });
    expect(result.ok).toBe(true);
    expect(result.entries).toEqual([]);
  });
});
