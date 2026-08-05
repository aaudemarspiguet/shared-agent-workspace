// Unit tests for the AGENT.md template in templates/agent-md.ts.
// The template must name every tool, every message type, and the key rules.
import { describe, expect, it } from "vitest";
import { renderAgentMd } from "../src/templates/agent-md.js";

const TOOL_NAMES = [
  "room_read",
  "room_post",
  "workspace_status",
  "work_log",
  "peer_activity"
];

const MESSAGE_TYPES = ["intent", "question", "decision", "handoff", "status"];

describe("renderAgentMd", () => {
  const text = renderAgentMd({
    workspaceName: "demo",
    githubUsername: "alice",
    branchPrefix: "alice/"
  });

  it("names all five MCP tools", () => {
    for (const name of TOOL_NAMES) {
      expect(text, `tool ${name} must appear`).toContain(`\`${name}\``);
    }
  });

  it("names all five message types", () => {
    for (const type of MESSAGE_TYPES) {
      expect(text, `type ${type} must appear`).toContain(`\`${type}\``);
    }
  });

  it("includes the member branch prefix", () => {
    expect(text).toContain("alice/");
  });

  it("tells the agent what to do when a ref is not found", () => {
    expect(text).toContain("ref not found");
  });

  it("states the messages-and-refs-only rule", () => {
    expect(text).toContain("Send only messages and git refs");
  });
});
