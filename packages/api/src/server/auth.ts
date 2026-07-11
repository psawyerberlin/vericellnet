import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyRequest } from "fastify";
import { ProblemError } from "./errors.js";
import type { TypedApp } from "./build.js";

const KEY_PREFIX = "vk_";

/** A fresh bearer API key — `vk_` + 32 random bytes of hex, shown once at creation. */
export function generateApiKey(): string {
  return KEY_PREFIX + randomBytes(32).toString("hex");
}

/** Only the SHA-256 hash of a key is ever persisted (TECHNICAL.md §7.4). */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export function extractBearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  // Buffers of different lengths would throw in timingSafeEqual; the length
  // check itself leaks a little timing information, but only the token
  // *length*, which isn't the secret being protected here.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * `preHandler` for every `/proofs*` route: resolves `Authorization: Bearer
 * <key>` to an `api_keys` row and decorates the request with its hash for
 * downstream idempotency scoping and per-key rate limiting. 401s on a
 * missing or unrecognized key — TECHNICAL.md §7.2's bearer-auth requirement.
 */
export function requireApiKey(app: TypedApp) {
  return async (req: FastifyRequest): Promise<void> => {
    const token = extractBearerToken(req);
    if (!token) {
      throw new ProblemError(401, "Unauthorized", "Missing bearer API key");
    }
    const keyHash = hashApiKey(token);
    const row = app.db.prepare("SELECT key_hash FROM api_keys WHERE key_hash = ?").get(keyHash);
    if (!row) {
      throw new ProblemError(401, "Unauthorized", "Invalid API key");
    }
    req.apiKeyHash = keyHash;
  };
}

/**
 * `preHandler` for `POST /api/v1/keys`: compares `Authorization: Bearer
 * <token>` against the `ADMIN_TOKEN` env var (constant-time). No token
 * configured means the route is unusable (500), rather than silently
 * accepting any caller.
 */
export function requireAdminToken(app: TypedApp) {
  return async (req: FastifyRequest): Promise<void> => {
    if (!app.adminToken) {
      throw new ProblemError(
        500,
        "Internal Server Error",
        "ADMIN_TOKEN is not configured on this server",
      );
    }
    const token = extractBearerToken(req);
    if (!token || !timingSafeEqualStr(token, app.adminToken)) {
      throw new ProblemError(401, "Unauthorized", "Invalid admin token");
    }
  };
}

/**
 * Per-key rate limiting (TECHNICAL.md §7.4: "Keyed endpoints: per-key limit
 * from `api_keys.rate_limit`"), scoped to the `/proofs*` child plugin
 * (separate registration from the global per-IP limiter in `build.ts`).
 * Both `keyGenerator`/`max` run *before* `requireApiKey`'s preHandler (rate
 * limiting is an `onRequest` hook), so an unrecognized/missing key is
 * capped at a low ceiling here and then 401s in the preHandler right after
 * — it never reaches a real per-key limit it doesn't have.
 */
export function perKeyRateLimitOptions(db: Database.Database): {
  keyGenerator: (req: FastifyRequest) => string;
  max: (req: FastifyRequest) => number;
} {
  return {
    keyGenerator: (req) => {
      const token = extractBearerToken(req);
      return token ? hashApiKey(token) : req.ip;
    },
    max: (req) => {
      const token = extractBearerToken(req);
      if (!token) return 5;
      const row = db
        .prepare("SELECT rate_limit FROM api_keys WHERE key_hash = ?")
        .get(hashApiKey(token)) as { rate_limit: number } | undefined;
      return row?.rate_limit ?? 60;
    },
  };
}
