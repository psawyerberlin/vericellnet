import pino from "pino";
import { makeClient } from "chain";
import { NETWORK } from "core";
import { openDb } from "../db/open.js";
import { Indexer } from "./indexer.js";

/** Standalone indexer worker entrypoint (Phase 10's `indexer` compose service). */
async function main(): Promise<void> {
  const logger = pino({ level: globalThis.process?.env?.LOG_LEVEL ?? "info" });
  const db = openDb();
  const client = makeClient();

  const pollIntervalMs = Number(globalThis.process?.env?.POLL_INTERVAL_MS ?? 3000);
  // Lets testnet/mainnet syncs start at VeriCell's first deployment block
  // instead of walking the whole chain from genesis.
  const startBlock = BigInt(globalThis.process?.env?.INDEXER_START_BLOCK ?? 0);

  logger.info({ network: NETWORK, pollIntervalMs }, "starting VeriCell indexer");
  const indexer = new Indexer({ db, client, logger, pollIntervalMs, startBlock });
  indexer.start();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    await indexer.stop();
    db.close();
    globalThis.process?.exit(0);
  };
  globalThis.process?.on("SIGINT", () => void shutdown("SIGINT"));
  globalThis.process?.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error(err);
  globalThis.process?.exit(1);
});
