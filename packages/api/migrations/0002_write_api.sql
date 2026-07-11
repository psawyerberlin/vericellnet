-- Phase 5: authenticated write endpoints (TECHNICAL.md §7.2). `api_keys` and
-- `webhooks` already exist verbatim from 0001_init.sql. `idempotency_keys`
-- is not in TECHNICAL.md §6 verbatim — an implementation detail of the
-- "Idempotency-Key on all POSTs" requirement, not a schema deviation.
--
-- Idempotency is scoped per API key (a replayed key from a different caller
-- must not collide) and per route (the same key reused across different
-- endpoints is a caller error, not something we shadow a stale response
-- for) — see DECISIONS.md.
CREATE TABLE idempotency_keys (
  key_hash        TEXT NOT NULL,       -- api_keys.key_hash of the caller, or 'admin' for /keys
  idempotency_key TEXT NOT NULL,
  method          TEXT NOT NULL,
  path            TEXT NOT NULL,
  status_code     INTEGER NOT NULL,
  response_body   TEXT NOT NULL,       -- JSON-encoded response body
  created_at      TEXT NOT NULL,
  PRIMARY KEY (key_hash, idempotency_key)
);
