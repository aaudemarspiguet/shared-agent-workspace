// work_log (T042).
// Query the automatic run log stored at the relay.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  agentGate,
  daemonCall,
  errorResult,
  jsonResult,
  mapDaemonError,
  NOT_RUNNING
} from "../call.js";

export function registerWorkLogTool(server: McpServer, root: string): void {
  server.registerTool(
    "work_log",
    {
      description:
        "Query the automatic work log. Every agent run is recorded with what, when, why, " +
        "and its work item. Boundary rejections appear here too.",
      inputSchema: {
        member: z
          .enum(["me", "peer", "any"])
          .optional()
          .describe("Whose runs. Default any."),
        work_item: z.string().optional().describe("Filter by feature tag."),
        since: z
          .string()
          .datetime()
          .optional()
          .describe("Only entries that ended at or after this UTC ISO time."),
        limit: z.number().int().min(1).max(200).optional().describe("Max entries. Default 50.")
      }
    },
    async (args: { member?: string; work_item?: string; since?: string; limit?: number }) => {
      const gate = await agentGate(root);
      if (gate) return gate;
      const params = new URLSearchParams();
      params.set("member", args.member ?? "any");
      if (args.work_item) params.set("work_item", args.work_item);
      if (args.since) params.set("since", args.since);
      params.set("limit", String(args.limit ?? 50));
      const res = await daemonCall(root, `/api/log?${params.toString()}`);
      if (!res) return errorResult("not_connected", NOT_RUNNING);
      if (res.status !== 200) return mapDaemonError(res.status, res.json);
      return jsonResult(res.json);
    }
  );
}
