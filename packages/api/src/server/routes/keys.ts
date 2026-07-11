import { requireAdminToken, generateApiKey, hashApiKey } from "../auth.js";
import { withIdempotency } from "../idempotency.js";
import { CreateKeyBodySchema } from "../writeSchemas.js";
import type { TypedApp } from "../build.js";

/**
 * `POST /api/v1/keys` — ADMIN_TOKEN-guarded (TECHNICAL.md §7.2's bearer-auth
 * keys are themselves minted here). The key is returned exactly once; only
 * its SHA-256 hash is ever persisted (`api_keys.key_hash`).
 */
export function registerKeyRoutes(app: TypedApp): void {
  app.post(
    "/api/v1/keys",
    {
      schema: {
        tags: ["keys"],
        summary: "Mint a new bearer API key (admin only)",
        body: CreateKeyBodySchema,
      },
      preHandler: requireAdminToken(app),
    },
    async (req, reply) => {
      // Idempotency is scoped by caller API key elsewhere; the admin route
      // has no api_keys row of its own to scope by, so it uses a fixed
      // scope — a replayed Idempotency-Key here always means the same admin.
      return withIdempotency(app.db, req, reply, "admin", async () => {
        const key = generateApiKey();
        const keyHash = hashApiKey(key);
        const { label, rate_limit } = req.body;

        app.db
          .prepare(
            "INSERT INTO api_keys (key_hash, label, created_at, rate_limit) VALUES (?, ?, ?, ?)",
          )
          .run(keyHash, label ?? null, new Date().toISOString(), rate_limit ?? 60);

        return {
          status: 201,
          body: {
            key,
            key_hash: keyHash,
            label: label ?? null,
            rate_limit: rate_limit ?? 60,
          },
        };
      });
    },
  );
}
