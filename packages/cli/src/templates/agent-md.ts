// The .saw/AGENT.md template.
// saw init and saw join write this file. Agents read it at session start.
// The text follows ASD-STE Simplified Technical English.

export interface AgentMdParams {
  workspaceName: string;
  githubUsername: string;
  branchPrefix: string;
}

/** Build the AGENT.md content for one member. */
export function renderAgentMd(params: AgentMdParams): string {
  const { workspaceName, githubUsername, branchPrefix } = params;
  return `# SAW instructions for the connected agent

You work in the shared workspace "${workspaceName}".
Your member is "${githubUsername}".
A second member and their agent can work in the same repository.
SAW connects you to them through a shared room.
Both humans can read every room message.

## The five tools

SAW gives you five MCP tools. Use them to coordinate. They never move code.

1. \`room_read\` — read room messages in order.
2. \`room_post\` — post one message to the room.
3. \`workspace_status\` — see members, presence, claims, and your pause state.
4. \`work_log\` — query the automatic run log.
5. \`peer_activity\` — see what the other member's agent did, even when they are offline.

## The five message types

Every room post has one type. Use the correct type.

- \`intent\` — you state what you will do next. An intent with a \`work_item\` claims that item.
- \`question\` — you need an answer from the other agent or human.
- \`decision\` — you record an agreed outcome. A decision with your claimed \`work_item\` closes it.
- \`handoff\` — you pass claimed work to the other member. Include a ref to your branch.
- \`status\` — you report progress or a problem. No reply is needed.

## How to claim and hand off work

1. Before you start a feature, post an \`intent\` with a short \`work_item\` tag. Example tag: \`login-form\`.
2. The first claim wins. If the room shows a rejected claim, pick other work or ask with a \`question\`.
3. To pass work over, push your branch first. Then post a \`handoff\` with a branch ref.
4. To accept a handoff, post an \`intent\` with the same \`work_item\`.
5. When the work is merged or complete, post a \`decision\` with the \`work_item\` to close it.

## Rules

- Send only messages and git refs through SAW. Never put code, diffs, file contents, or long
  encoded data in a message body. The relay rejects such posts and logs the rejection.
- A ref is a branch name or a commit SHA. Share code locations only as refs.
- Work only on branches with your prefix: \`${branchPrefix}\`. Never force-push the other
  member's branches.
- Code moves only through git. Push to the existing remote. Fetch the other member's refs
  from the remote.
- Merges are agreed in the room first. A \`decision\` message records the agreement.
- When a received ref is not on the remote, do not fail silently. Run \`git fetch\` once more.
  If the ref is still missing, post a \`status\` message that reports "ref not found" with the
  ref name, and continue with other work.
- Check \`workspace_status\` when tools return errors. It shows whether SAW is connected and
  whether your member is paused.
- Your human can pause you. While paused, coordinated actions are blocked. Wait for resume.

## Start of a session

1. Read this file.
2. Call \`workspace_status\` to see the current state.
3. Call \`room_read\` if unread messages were not already injected.
4. Announce non-trivial work with an \`intent\` before you start it.
`;
}
