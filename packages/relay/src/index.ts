// Relay entry point. Start with: npm run dev --workspace @saw/relay
export * from "./store.js";
export * from "./server.js";
export * from "./boundary.js";
export * from "./join.js";

import { startRelay } from "./server.js";

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("relay/src/index.ts");
if (isMain) {
  const port = Number(process.env.SAW_RELAY_PORT ?? 8787);
  const dbPath = process.env.SAW_RELAY_DB ?? "saw-relay.db";
  const relay = await startRelay(dbPath, port);
  console.log(`SAW relay is up on port ${relay.port}. Database: ${dbPath}`);
}
