// The SHIPPING adapter, driven for real (the #98/#200 lesson): every other
// suite injects a fake adapter, which left this file with zero coverage —
// how a spawn bug survived one review and how its "fix" then landed as an
// import with no call site. A fake `claude` on PATH records how it was
// started; the assertions read the record. POSIX drives the passthrough
// half of launchFor here; the Windows shim half is covered by the pure
// units in launch.test.ts and verified on the Windows machine, as with #179.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeWakeAdapter } from "../src/daemon/wake.js";

const posix = process.platform !== "win32";
let dir: string;
let record: string;
let oldPath: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "saw-wake-"));
  record = join(dir, "record.txt");
  oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath ?? ""}`;
  writeFileSync(
    join(dir, "claude"),
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${record}"\n` +
      `printf 'SAW_COMPANION=%s\\n' "\${SAW_COMPANION:-unset}" >> "${record}"\n`,
    { mode: 0o755 }
  );
});

afterEach(() => {
  process.env.PATH = oldPath;
  rmSync(dir, { recursive: true, force: true });
});

describe.runIf(posix)("the Claude adapter, spawning for real (T151)", () => {
  it("finds the tool on PATH and starts it with the wake prompt", async () => {
    const adapter = new ClaudeWakeAdapter();
    expect(adapter.supportsWake()).toBe(true);
    const out = await adapter.startRun(
      {
        threadId: "t-real-spawn",
        threadTitle: "the real spawn",
        reason: "own_message",
        sessionId: null
      },
      dir
    );
    expect(out.ok).toBe(true);
    const ran = readFileSync(record, "utf8");
    expect(ran).toContain("-p");
    expect(ran).toContain("SAW woke you");
    expect(ran).toContain("the real spawn");
    expect(ran).toContain("SAW_COMPANION=unset");
  });
});
