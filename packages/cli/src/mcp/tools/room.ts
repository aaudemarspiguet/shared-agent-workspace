// room_read and room_post (T026).
// room_read returns messages in seq order. It never moves the read cursor.
// room_post is the only way an agent sends anything to the peer.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { composePost } from "../plain-speech.js";
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
        "Post one message to the shared room. Two people read the room on their phones: " +
        "`summary` is for them, `details` is for the other agent. Only messages and git refs " +
        "cross to the peer. An intent with a work_item claims it; the first claim wins.",
      inputSchema: {
        type: z
          .enum(["intent", "question", "decision", "handoff", "status"])
          .describe("The message type."),
        summary: z
          .string()
          .min(1)
          .max(2000)
          .optional()
          .describe(
            "For the humans: what happened, and what you need from them, in plain words - " +
              "a few sentences, under about 700 characters. This is the part they read, so lead " +
              "with the point and end with the ask. A pull request number or link is fine; that " +
              "is how a person finds the work. Task and spec numbers, commit hashes, and internal " +
              "words are not - say \"start\" not \"wake\", \"final\" not \"binding\"."
          ),
        details: z
          .string()
          .min(1)
          .max(4000)
          .optional()
          .describe(
            "For the other agent: shorthand, task numbers, commit ids, evidence - anything " +
              "that helps the work. The humans see it only if they open it. No heading needed; " +
              "the page keeps the parts apart. Summary and details together must fit 4000 " +
              "characters. No code, no diffs."
          ),
        body: z
          .string()
          .min(1)
          .max(4000)
          .optional()
          .describe("Older callers only. Prefer summary and details."),
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
      // Two registers, one stored message: the summary for the humans first,
      // the details for the other agent after a blank line (plain-speech
      // plan). The daemon and relay see one body, exactly as before. This
      // is pure, so it runs before the gate spends a daemon call.
      const composed = composePost(args);
      if (!composed.ok) return errorResult("invalid_input", composed.message);
      const threadId = typeof args.thread_id === "string" ? args.thread_id : undefined;
      // A post carrying refs binds them to the thread (FR-014), and binding
      // needs the member's own mode at `edit` — CHK007, answered 2026-08-31.
      // Gating the whole post at `post` let a member in `comment` bind refs,
      // because binding rode along on an action that needs one rung less.
      const bindsRefs = Array.isArray(args.refs) && args.refs.length > 0;
      const gate = await agentGate(
        root,
        threadId
          ? {
              threadId,
              action: bindsRefs ? "bind_ref" : args.type === "intent" ? "claim" : "post"
            }
          : undefined
      );
      if (gate) return gate;
      const res = await daemonCall(root, "/api/post", {
        method: "POST",
        // A run the companion started carries SAW_COMPANION=1 (FR-053):
        // its posts take the companion identity structurally, not by hoping
        // the prompt is obeyed.
        body: {
          type: args.type,
          body: composed.body,
          ...(args.refs !== undefined ? { refs: args.refs } : {}),
          ...(args.work_item !== undefined ? { work_item: args.work_item } : {}),
          ...(threadId !== undefined ? { thread_id: threadId } : {}),
          sender_kind: process.env.SAW_COMPANION === "1" ? "companion" : "agent"
        }
      });
      if (!res) return errorResult("not_connected", NOT_RUNNING);
      if (res.status !== 200) return mapDaemonError(res.status, res.json);
      // The one soft guardrail: a long summary gets a sentence back, and the
      // post has already gone through.
      const answer = res.json as Record<string, unknown>;
      return jsonResult(composed.note ? { ...answer, note: composed.note } : answer);
    }
  );
}
