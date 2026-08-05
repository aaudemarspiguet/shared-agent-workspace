// peer_activity (T046).
// Answer "what did my teammate's agent do since X" from relay storage.
// It works while the peer is fully offline. Empty windows get an honest
// empty answer. The agent must report "no recorded activity", never guess.
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

export function registerPeerActivityTool(server: McpServer, root: string): void {
  server.registerTool(
    "peer_activity",
    {
      description:
        "What the other member's agent did since a time: their runs and room messages, " +
        "served from stored history. Works while the peer is offline. When runs and " +
        "messages are empty, report 'no recorded activity' — never guess.",
      inputSchema: {
        since: z
          .string()
          .datetime()
          .describe("Required UTC ISO time. The answer covers activity at or after it."),
        limit: z.number().int().min(1).max(200).optional().describe("Max items. Default 50.")
      }
    },
    async (args: { since: string; limit?: number }) => {
      const gate = await agentGate(root);
      if (gate) return gate;
      const params = new URLSearchParams();
      params.set("since", args.since);
      params.set("limit", String(args.limit ?? 50));
      const res = await daemonCall(root, `/api/peer-activity?${params.toString()}`);
      if (!res) return errorResult("not_connected", NOT_RUNNING);
      if (res.status !== 200) return mapDaemonError(res.status, res.json);
      return jsonResult(res.json);
    }
  );
}
