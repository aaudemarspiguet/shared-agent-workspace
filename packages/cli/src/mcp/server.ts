// The MCP stdio server (T025).
// The coding tool spawns `saw mcp`. The server exposes exactly five tools.
// Each tool talks to the member's own daemon. Nothing reaches the peer.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveRepoRoot } from "../config.js";
import { registerPeerActivityTool } from "./tools/peer-activity.js";
import { registerRoomTools } from "./tools/room.js";
import { registerThreadTools } from "./tools/thread-open.js";
import { registerStatusTool } from "./tools/status.js";
import { registerWorkLogTool } from "./tools/work-log.js";

export function createMcpServer(root: string): McpServer {
  const server = new McpServer({
    name: "saw",
    version: "0.1.0"
  });
  registerRoomTools(server, root);
  registerThreadTools(server, root);
  registerStatusTool(server, root);
  registerWorkLogTool(server, root);
  registerPeerActivityTool(server, root);
  return server;
}

/** Run the stdio MCP server until the coding tool closes it. */
export async function runMcpServer(): Promise<void> {
  const root = resolveRepoRoot(process.cwd());
  if (!root) {
    // Without a repository there is no workspace. Exit quietly: the coding
    // tool shows the server as unavailable and the agent works normally.
    process.exit(0);
  }
  const server = createMcpServer(root);
  await server.connect(new StdioServerTransport());
}
