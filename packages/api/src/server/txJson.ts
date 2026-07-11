import { ccc } from "chain";
import { ProblemError } from "./errors.js";

/**
 * `ccc.stringify` is CCC's own bigint-safe JSON serialization for
 * `Transaction` (capacities etc. become hex strings) — round-tripping a tx
 * through `JSON.parse(ccc.stringify(tx))` → `ccc.Transaction.from(...)`
 * reproduces the exact same tx (same hash), verified empirically. This is
 * the wire format `/proofs/prepare` returns and `/proofs/submit` expects.
 */
export function txToJson(tx: ccc.Transaction): unknown {
  return JSON.parse(ccc.stringify(tx)) as unknown;
}

/** Parses a `txToJson`-shaped body into a `Transaction`, wrapping any parse failure as a 400. */
export function txFromJson(value: unknown): ccc.Transaction {
  try {
    return ccc.Transaction.from(value as ccc.TransactionLike);
  } catch (err) {
    throw new ProblemError(
      400,
      "Bad Request",
      `Invalid transaction: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
