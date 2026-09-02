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

  server.registerTool(
    "thread_mode",
    {
      description:
        "Read or set YOUR OWN collaboration mode on a thread: view < comment < edit. " +
        "There is no way to set another member's mode, by design.",
      inputSchema: {
        thread_id: z.string().min(1).max(26).describe("The thread."),
        mode: z
          .enum(["view", "comment", "edit"])
          .optional()
          .describe("Omit to read the current mode.")
      }
    },
    async (args: { thread_id: string; mode?: "view" | "comment" | "edit" }) => {
      const gate = await agentGate(root);
      if (gate) return gate;
      if (args.mode === undefined) {
        const res = await daemonCall(root, `/api/mode?thread_id=${args.thread_id}`);
        if (!res) return errorResult("not_connected", NOT_RUNNING);
        if (res.status !== 200) return mapDaemonError(res.status, res.json);
        return jsonResult(res.json);
      }
      const res = await daemonCall(root, "/api/thread/mode", {
        method: "POST",
        body: { thread_id: args.thread_id, mode: args.mode }
      });
      if (!res) return errorResult("not_connected", NOT_RUNNING);
      if (res.status !== 200) return mapDaemonError(res.status, res.json);
      return jsonResult(res.json);
    }
  );

  server.registerTool(
    "session_propose_done",
    {
      description:
        "Propose that your live session's task is finished. A human must " +
        "approve before anything concludes - your proposal never closes work " +
        "by itself.",
      inputSchema: {
        session_id: z.string().min(1).max(26).describe("The session, from workspace_status."),
        summary: z
          .string()
          .min(1)
          .max(2000)
          .describe("Plain text: what was done and why it is complete."),
        refs: z
          .array(z.object({ kind: z.enum(["branch", "commit"]), value: z.string().min(1) }))
          .max(10)
          .optional()
          .describe("The branches or commits carrying the work.")
      }
    },
    async (args: {
      session_id: string;
      summary: string;
      refs?: { kind: "branch" | "commit"; value: string }[];
    }) => {
      const gate = await agentGate(root);
      if (gate) return gate;
      const res = await daemonCall(root, "/api/session/propose", {
        method: "POST",
        body: { session_id: args.session_id, summary: args.summary, refs: args.refs ?? [] }
      });
      if (!res) return errorResult("not_connected", NOT_RUNNING);
      if (res.status !== 200) return mapDaemonError(res.status, res.json);
      return jsonResult(res.json);
    }
  );

  server.registerTool(
    "thread_handoff",
    {
      description:
        "Hand a thread's claim to the other member, or answer a handoff. " +
        "The claim moves only when the recipient accepts. Accepting needs " +
        "your own mode at edit.",
      inputSchema: {
        action: z
          .enum(["propose", "accept", "decline", "withdraw"])
          .describe("propose starts one; the rest answer an existing one."),
        thread_id: z.string().min(1).max(26).optional().describe("For propose."),
        to: z.string().min(1).max(100).optional().describe("For propose: the recipient."),
        tip_ref: z
          .object({ kind: z.enum(["branch", "commit"]), value: z.string().min(1) })
          .optional()
          .describe("For propose: your current tip."),
        handoff_id: z.string().min(1).max(26).optional().describe("For accept/decline/withdraw.")
      }
    },
    async (args: {
      action: "propose" | "accept" | "decline" | "withdraw";
      thread_id?: string;
      to?: string;
      tip_ref?: { kind: "branch" | "commit"; value: string };
      handoff_id?: string;
    }) => {
      const gate = await agentGate(
        root,
        args.action === "accept" && args.thread_id
          ? { threadId: args.thread_id, action: "accept_handoff" }
          : undefined
      );
      if (gate) return gate;
      const res = await daemonCall(root, "/api/handoff", {
        method: "POST",
        body:
          args.action === "propose"
            ? { action: "propose", thread_id: args.thread_id, to: args.to, tip_ref: args.tip_ref }
            : { action: args.action, handoff_id: args.handoff_id }
      });
      if (!res) return errorResult("not_connected", NOT_RUNNING);
      if (res.status !== 200) return mapDaemonError(res.status, res.json);
      return jsonResult(res.json);
    }
  );
}
