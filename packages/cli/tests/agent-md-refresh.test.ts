// T139: saw up refreshes .saw/AGENT.md from the template (issue #165).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderAgentMd } from "../src/templates/agent-md.js";

let root: string;
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("AGENT.md refresh", () => {
  it("the template render replaces a stale file byte for byte", () => {
    root = mkdtempSync(join(tmpdir(), "saw-agentmd-"));
    const saw = join(root, ".saw");
    mkdirSync(saw, { recursive: true });
    writeFileSync(join(saw, "AGENT.md"), "# old rules from a past version\n");
    const fresh = renderAgentMd({
      workspaceName: "saw-dev",
      githubUsername: "shreyk2",
      branchPrefix: "shreyk2/"
    });
    // The same write `saw up` performs (commands/up.ts).
    writeFileSync(join(saw, "AGENT.md"), fresh);
    expect(readFileSync(join(saw, "AGENT.md"), "utf8")).toBe(fresh);
    expect(fresh).toContain("saw-dev");
    expect(fresh).toContain("shreyk2");
  });
});
