// Public entry point for @saw/cli.
// The integration tests import the daemon and config helpers from here.
export * from "./config.js";
export * from "./relay-http.js";
export * from "./daemon/daemon.js";
export { RelayClient } from "./daemon/client.js";
export {
  generateLocalToken,
  WS_PROTOCOL,
  WS_TOKEN_PROTOCOL_PREFIX
} from "./daemon/local-auth.js";
export { LogSpool, SPOOL_CAPACITY, type SpooledRun } from "./daemon/log-spool.js";
export { startWebServer } from "./web/server.js";
export { installHooks, sawHookCommandBase } from "./hooks/install.js";
export { composeRunWhat, countToolUses, gitWhat } from "./hooks/summary.js";
export { renderAgentMd } from "./templates/agent-md.js";
export { renderContext, type InjectResponse } from "./hooks/inject.js";
export { writeMemberFiles } from "./commands/init.js";
