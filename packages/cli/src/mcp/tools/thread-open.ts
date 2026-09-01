// thread_open (spec 002 T110, contracts 1.2).
// Open a thread: the unit of collaboration. Scope is project in v1.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { agentGate, daemonCall, errorResult, jsonResult, mapDaemonError, NOT_RUNNING } from "../call.js";

export function registerThreadTools(server: McpServer, root: string): void {
  server.registerTool(
    "thread_open",
    {
      description:
        "Open a thread. A thread is the unit of collaboration: post into it, " +
        "claim it (work_item type), bind refs to it. Scope is project in v1.",
      inputSchema: {
        type: z
          .enum(["work_item", "brainstorm", "general"])
          .describe("work_item takes claims; brainstorm and general are conversation."),
        title: z.string().min(1).max(200).describe("Plain text. No code, no diffs.")
      }
    },
    async (args: { type: "work_item" | "brainstorm" | "general"; title: string }) => {
      const gate = await agentGate(root);
      if (gate) return gate;
      const res = await daemonCall(root, "/api/thread/open", {
        method: "POST",
        body: { type: args.type, title: args.title }
      });
      if (!res) return errorResult("not_connected", NOT_RUNNING);
      if (res.status !== 200) return mapDaemonError(res.status, res.json);
      return jsonResult(res.json);
    }
  );
}
