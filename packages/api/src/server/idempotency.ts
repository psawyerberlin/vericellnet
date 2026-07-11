import type Database from "better-sqlite3";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ConflictError } from "./errors.js";

interface IdempotencyRow {
  method: string;
  path: string;
  status_code: number;
  response_body: string;
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * Look up a previously stored response for `(keyHash, idempotencyKey)`. A
 * key reused against a *different* method/path is a caller error (silently
 * replaying the wrong response would be worse than rejecting it), not a
 * cache hit — surfaced as 409.
 */
function getStoredResponse(
  db: Database.Database,
  keyHash: string,
  idempotencyKey: string,
  method: string,
  path: string,
): { statusCode: number; body: unknown } | null {
  const row = db
    .prepare(
      "SELECT method, path, status_code, response_body FROM idempotency_keys WHERE key_hash = ? AND idempotency_key = ?",
    )
    .get(keyHash, idempotencyKey) as IdempotencyRow | undefined;
  if (!row) return null;

  if (row.method !== method || row.path !== path) {
    throw new ConflictError(
      `Idempotency-Key "${idempotencyKey}" was already used for a different request (${row.method} ${row.path})`,
    );
  }
  return { statusCode: row.status_code, body: JSON.parse(row.response_body) as unknown };
}

function storeResponse(
  db: Database.Database,
  keyHash: string,
  idempotencyKey: string,
  method: string,
  path: string,
  statusCode: number,
  body: unknown,
): void {
  db.prepare(
    `INSERT INTO idempotency_keys (key_hash, idempotency_key, method, path, status_code, response_body, created_at)
     VALUES (@keyHash, @idempotencyKey, @method, @path, @statusCode, @responseBody, @createdAt)
     ON CONFLICT(key_hash, idempotency_key) DO NOTHING`,
  ).run({
    keyHash,
    idempotencyKey,
    method,
    path,
    statusCode,
    responseBody: JSON.stringify(body),
    createdAt: new Date().toISOString(),
  });
}

/**
 * Wrap a write-route handler with `Idempotency-Key` support (TECHNICAL.md
 * §7.2): if the header is present and a stored response exists for this
 * key, replay it verbatim instead of re-running `handler` (never double-
 * anchors a proof). Without the header, every call runs normally.
 */
export async function withIdempotency<T>(
  db: Database.Database,
  req: FastifyRequest,
  reply: FastifyReply,
  keyHash: string,
  handler: () => Promise<{ status: number; body: T }>,
): Promise<T> {
  const idempotencyKey = headerValue(req.headers["idempotency-key"]);

  if (idempotencyKey) {
    const cached = getStoredResponse(
      db,
      keyHash,
      idempotencyKey,
      req.method,
      req.routeOptions.url ?? req.url,
    );
    if (cached) {
      reply.code(cached.statusCode);
      return cached.body as T;
    }
  }

  const { status, body } = await handler();
  reply.code(status);

  if (idempotencyKey) {
    storeResponse(
      db,
      keyHash,
      idempotencyKey,
      req.method,
      req.routeOptions.url ?? req.url,
      status,
      body,
    );
  }

  return body;
}
