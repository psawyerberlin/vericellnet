import pino from "pino";
import { NETWORK } from "core";
import { openDb } from "../db/open.js";
import { buildServer } from "./build.js";

/** Standalone API server entrypoint (Phase 10's `api` compose service). */
async function main(): Promise<void> {
  const logger = pino({
    level: globalThis.process?.env?.LOG_LEVEL ?? "info",
    // Write routes (`/proofs*`, `/keys`) carry manifests, signed transactions
    // and bearer keys in their bodies/headers — never persist those to logs,
    // defense in depth on top of never `req.log`-ing a body in a handler.
    redact: {
      paths: ["req.body", "req.headers.authorization"],
      censor: "[redacted]",
    },
  });
  const db = openDb();
  const port = Number(globalThis.process?.env?.PORT ?? 3000);

  const app = buildServer({ db, network: NETWORK, loggerInstance: logger });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down");
    await app.close();
    db.close();
    globalThis.process?.exit(0);
  };
  globalThis.process?.on("SIGINT", () => void shutdown("SIGINT"));
  globalThis.process?.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ port, host: "0.0.0.0" });
  logger.info({ network: NETWORK, port }, "VeriCell API listening");
}

main().catch((err: unknown) => {
  console.error(err);
  globalThis.process?.exit(1);
});
