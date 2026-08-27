// saw share-relay: make this machine's relay reachable with zero network
// configuration on the other side. Prints the `iroh:` address that goes in
// .saw/config.json. Runs in the foreground, next to the relay itself.
import { homedir } from "node:os";
import { join } from "node:path";
import { readSharedConfig, resolveRepoRoot, writeSharedConfig } from "../config.js";
import { hostTunnel } from "../tunnel.js";
import { relayUrls } from "../relay-http.js";

export interface ShareRelayOptions {
  /** The relay this machine runs. Default ws://127.0.0.1:8787. */
  target?: string;
  /** Where the host key lives. The key keeps the address stable. */
  key?: string;
  /** Write the address into .saw/config.json of this repository. */
  writeConfig?: boolean;
}

export async function runShareRelay(options: ShareRelayOptions): Promise<void> {
  const target = new URL(relayUrls(options.target ?? "ws://127.0.0.1:8787").http);
  const keyFile = options.key ?? join(homedir(), ".saw", "relay-tunnel.key");

  const tunnel = await hostTunnel({
    targetHost: target.hostname,
    targetPort: Number(target.port || 80),
    keyFile
  });

  console.log(`Sharing the relay at ${target.host} (host key ${tunnel.shortId}).`);
  console.log("");
  console.log("Relay address for .saw/config.json:");
  console.log("");
  console.log(`  ${tunnel.address}`);
  console.log("");

  if (options.writeConfig) {
    const root = resolveRepoRoot();
    const shared = root ? readSharedConfig(root) : undefined;
    if (root && shared) {
      writeSharedConfig(root, { ...shared, relay_url: tunnel.address });
      console.log("Wrote the address into .saw/config.json. Commit that file.");
    } else {
      console.log("No workspace in this directory. The address was not written.");
    }
    console.log("");
  }

  console.log("Members reach the relay through this process. Keep it running");
  console.log("whenever the relay runs. Stop with Ctrl-C.");

  const stop = async (): Promise<void> => {
    await tunnel.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  // Stay alive until a signal. The accept loop does the work.
  await new Promise<void>(() => {});
}
