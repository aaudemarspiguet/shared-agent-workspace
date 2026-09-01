// room_read and room_post (T026).
// room_read returns messages in seq order. It never moves the read cursor.
// room_post is the only way an agent sends anything to the peer.
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

export function registerRoomTools(server: McpServer, root: string): void {
  server.registerTool(
    "room_read",
    {
      description:
        "Read room messages in order, newest last. " +
        "Default start is your last injected cursor. " +
        "Give work_item to see one work item only.",
      inputSchema: {
        since_seq: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Return messages with seq greater than this. Default: last injected cursor."),
        limit: z.number().int().min(1).max(200).optional().describe("Max messages. Default 50."),
        work_item: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe("Feature tag. Return only messages for this work item. Default: all."),
        thread_id: z
          .string()
          .min(1)
          .max(26)
          .optional()
          .describe("Thread id from workspace_status. Return only that thread. Default: all.")
      }
    },
    async (args: {
      since_seq?: number;
      limit?: number;
      work_item?: string;
      thread_id?: string;
    }) => {
      const gate = await agentGate(root);
      if (gate) return gate;
      const params = new URLSearchParams();
      if (args.since_seq !== undefined) params.set("since_seq", String(args.since_seq));
      params.set("limit", String(args.limit ?? 50));
      if (args.work_item !== undefined) params.set("work_item", args.work_item);
      if (args.thread_id !== undefined) params.set("thread_id", args.thread_id);
      const res = await daemonCall(root, `/api/messages?${params.toString()}`);
      if (!res) return errorResult("not_connected", NOT_RUNNING);
      if (res.status !== 200) return mapDaemonError(res.status, res.json);
      return jsonResult(res.json);
    }
  );

  server.registerTool(
    "room_post",
    {
      description:
        "Post one message to the shared room. Only messages and git refs cross to the peer. " +
        "An intent with a work_item claims it; the first claim wins.",
      inputSchema: {
        type: z
          .enum(["intent", "question", "decision", "handoff", "status"])
          .describe("The message type."),
        body: z.string().min(1).max(4000).describe("Plain text. No code, no diffs."),
        refs: z
          .array(
            z.object({
              kind: z.enum(["branch", "commit"]),
              value: z.string().min(1)
            })
          )
          .max(10)
          .optional()
          .describe("Git refs: branch names or commit SHAs. The only pointers to code."),
        work_item: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe("Feature tag. An intent with this claims the item."),
        thread_id: z
          .string()
          .min(1)
          .max(26)
          .optional()
          .describe(
            "Post into this thread. Omitted with no work_item means a project broadcast. " +
              "An intent into a work_item thread claims it; the first claim wins."
          )
      }
    },
    async (args: Record<string, unknown>) => {
      const threadId = typeof args.thread_id === "string" ? args.thread_id : undefined;
      const gate = await agentGate(
        root,
        threadId
          ? { threadId, action: args.type === "intent" ? "claim" : "post" }
          : undefined
      );
      if (gate) return gate;
      const res = await daemonCall(root, "/api/post", {
        method: "POST",
        // A run the companion started carries SAW_COMPANION=1 (FR-053):
        // its posts take the companion identity structurally, not by hoping
        // the prompt is obeyed.
        body: {
          ...args,
          sender_kind: process.env.SAW_COMPANION === "1" ? "companion" : "agent"
        }
      });
      if (!res) return errorResult("not_connected", NOT_RUNNING);
      if (res.status !== 200) return mapDaemonError(res.status, res.json);
      return jsonResult(res.json);
    }
  );
}
