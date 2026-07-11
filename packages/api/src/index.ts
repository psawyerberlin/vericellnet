export { openDb } from "./db/open.js";
export { resolveDbPath } from "./db/path.js";
export { runMigrations } from "./db/migrate.js";
export {
  Indexer,
  type IndexerOptions,
  type IndexerClient,
  type Logger,
  processBlock,
  detectCandidates,
  type Candidate,
  getSyncState,
  setSyncState,
  rollback,
  type SyncState,
} from "./indexer/index.js";
export { buildServer, type BuildServerOptions, type TypedApp } from "./server/build.js";
export {
  defaultFetchProof,
  defaultGetTip,
  type FetchProofFn,
  type GetTipFn,
} from "./server/chainLookup.js";
export {
  ProblemError,
  NotFoundError,
  BadGatewayError,
  ForbiddenError,
  ConflictError,
} from "./server/errors.js";
export {
  generateApiKey,
  hashApiKey,
  extractBearerToken,
  requireApiKey,
  requireAdminToken,
  perKeyRateLimitOptions,
} from "./server/auth.js";
export { withIdempotency } from "./server/idempotency.js";
export {
  defaultGetChainClient,
  defaultGetCustodialSigner,
  resolveCustodialEnabled,
  type GetChainClientFn,
  type GetCustodialSignerFn,
} from "./server/chainClient.js";

// Phase 6+ fills this in further: webhooks.
