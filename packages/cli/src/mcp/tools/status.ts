// workspace_status (T027).
// A snapshot of the workspace. Always available, even while paused.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { daemonCall, errorResult, jsonResult, mapDaemonError, NOT_RUNNING } from "../call.js";

export function registerStatusTool(server: McpServer, root: string): void {
  server.registerTool(
    "workspace_status",
    {
      description:
        "Snapshot of the SAW workspace: members, presence, pause state, unread count, " +
        "work items, and relay connection. Works while paused.",
      inputSchema: {}
    },
    async () => {
      const res = await daemonCall(root, "/api/status");
      if (!res) return errorResult("not_connected", NOT_RUNNING);
      if (res.status !== 200) return mapDaemonError(res.status, res.json);
      return jsonResult(res.json);
    }
  );
}
