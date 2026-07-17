# Security review — Phase 9

Checklist run against the state of the repo after Phase 8 (`packages/core`, `packages/chain`,
`packages/api`, `packages/web`, `packages/cli`). Each section ends with a verdict: **Pass** (no
change needed), **Fixed** (a gap found and closed in this phase — see the linked commit), or
**Accepted trade-off** (a real property worth naming, deliberately not changed, with the
reasoning recorded here rather than left implicit).

> Updated for v1.1.0: custodial anchoring was removed entirely (see §6 and
> `docs/DECISIONS.md`); every other section below still describes the current, non-custodial-only
> state of the repo.

## 1. Key handling

- **API keys** (`packages/api/src/server/auth.ts`): minted as `vk_` + 32 random bytes
  (`generateApiKey`), shown once in the `POST /api/v1/keys` response body, stored only as
  `sha256(key)` in `api_keys.key_hash`. Every write route resolves `Authorization: Bearer <key>`
  by hashing the presented token and looking up the hash — the plaintext key is never persisted,
  never appears in a `SELECT`, and (via `server/run.ts`'s pino `redact: ["req.headers.authorization"]`)
  never reaches the request log. **Pass.**
- **Idempotency replay of `POST /api/v1/keys` stores the raw minted key in `idempotency_keys.response_body`.**
  `withIdempotency` persists the exact response body verbatim so a retried `Idempotency-Key`
  request replays byte-for-byte — for every other write route that's harmless (a `tx_hash`/`unid`),
  but for `/keys` the response body *is* the one-time secret, so a second copy of it now lives in
  the DB in cleartext, deliberately (see `packages/api/src/server/routes/proofs.test.ts`, "Idempotency-Key
  replay returns the same minted key, not a new one" — Phase 5 built this intentionally, and true
  idempotent replay is definitionally incompatible with "shown once"). **Accepted trade-off**: this
  is not a new class of exposure — `webhooks.secret` is already stored in cleartext by deliberate
  design (`docs/DECISIONS.md`, Phase 6), so the DB file already has to be treated as
  secret-bearing, not just key-hash-bearing. Anyone who can read `idempotency_keys` already has
  filesystem access to the SQLite file, at which point `webhooks.secret` and other deployment
  secrets are equally exposed. Mitigation for operators: restrict the DB file's OS
  permissions to the API/indexer process user (Phase 10's Docker image should run as non-root with
  a private volume), and treat `/keys` retries as rare/manual rather than an automated hot path.
- **CLI signer keys never leave the client.** `vericell anchor` / `vericell withdraw` read the
  key only from `--signer-key-file` (a local file path, never a CLI argument — so it never appears
  in `ps`/shell history the way `--key` necessarily does), sign in-process, and only the *signed
  transaction* crosses the network to `/proofs/submit`. `packages/cli/src/lib/signer.ts` never
  logs the key content; none of the command modules print it. **Pass.**
- **`--key <api-key>` is a CLI argument, not an env var**, so it is visible to other processes on
  the same host via `ps`/`/proc/<pid>/cmdline` for the duration of the command, and lands in shell
  history unless the user takes precautions. This matches `ClaudeCodeInstruction.md`'s Phase 8
  literal flag signature (`--key <k>`), so it isn't changed here, but is worth naming: a lower-risk
  alternative (e.g. also accepting `VERICELL_API_KEY` from the environment) is a reasonable future
  enhancement, out of scope for this phase. **Accepted trade-off**, documented for a future phase.
- **Manifest/tx bodies and bearer tokens are excluded from API request logs**
  (`server/run.ts`'s pino `redact: ["req.body", "req.headers.authorization"]`), on top of no route
  handler ever calling `req.log` with the raw body. **Pass.**

## 2. Rate limits

| Route class | Limiter | Default |
|---|---|---|
| Public reads (`GET /projects`, `/versions/{tx}`, `/hashes/{sha}`, `/verify/{sha}`, `/stats`, `/health`) | Global, per-IP (`@fastify/rate-limit`, `build.ts`) | 60/min |
| Authenticated writes (`/proofs*`, `/webhooks*`) | Per-key (`perKeyRateLimitOptions`, keyed by the hashed bearer token) | `api_keys.rate_limit`, default 60/min |
| Authenticated writes, missing/invalid bearer token | Per-IP fallback inside the same per-key limiter (`perKeyRateLimitOptions`'s `keyGenerator`/`max` fall back to `req.ip`/`5`) | 5/min |
| `POST /api/v1/keys` (admin) | Global per-IP only (registered outside the write child-plugin, so it doesn't get a per-key limiter of its own — there's no key yet) | 60/min |

`POST /api/v1/keys` sitting on the generous public-read limit (60/min) rather than a tighter
admin-specific one is intentional but worth flagging: it's guarded by `ADMIN_TOKEN` compared with
`timingSafeEqual` (`auth.ts`'s `requireAdminToken`), and 60 attempts/minute against a full-entropy
random token is not a practically exploitable brute-force budget. **Pass**, with a note that an
operator issuing a deliberately weak `ADMIN_TOKEN` is the actual residual risk, not the rate limit.

## 3. Input validation coverage

Every route with a body, params, or querystring validates through a zod schema
(`fastify-type-provider-zod`), enumerated below; the only routes with *no* schema
(`GET /health`, `GET /stats`) take no input at all.

| Route | Schema |
|---|---|
| `GET /projects` | `ProjectsQuery` |
| `GET /projects/{unid}` | `UnidParams` |
| `GET /versions/{txHash}` | `TxHashParams` |
| `GET /hashes/{sha256}` | `Sha256Params` |
| `GET /verify/{sha256}` | `Sha256Params` |
| `POST /keys` | `CreateKeyBodySchema` |
| `POST /proofs/prepare` | `PrepareBodySchema` (anchor: `ManifestDraftSchema` + `PayerSchema`; withdraw: `withdraw_tx_hash`) |
| `POST /proofs/submit` | `SubmitBodySchema` |
| `POST /webhooks` | `RegisterWebhookBodySchema` |
| `DELETE /webhooks/{id}` | `WebhookIdParams` |

A failed validation is normalized to `400 application/problem+json` by the shared error handler
(`hasZodFastifySchemaValidationErrors` branch in `build.ts`), so no route can be reached with a
malformed body/param past the schema boundary. **Pass.**

## 4. SQL injection

Every query in `packages/api/src` goes through `better-sqlite3`'s `.prepare(...).run/get/all(...)`
with named (`@x`) or positional (`?`) bound parameters — grepped for any `.prepare()` call
containing a template-literal `${...}` substitution of a *value*; the only two matches
(`server/queries.ts`'s `listProjects`, building a `WHERE ${where}` clause) interpolate only a
`where` string assembled from a fixed set of static clause fragments (`"p.title LIKE @q"`, etc.);
every actual value flows through the bound-parameter object, never string concatenation. No route
handler or indexer/webhook code path builds SQL from user-controlled string content. **Pass.**

## 5. Webhook SSRF guard

`packages/api/src/webhooks/guard.ts`'s `assertPublicWebhookUrl` runs at `POST /webhooks`
registration time and again immediately before every delivery attempt (defense against DNS
rebinding between the two): rejects non-`http(s)` schemes, resolves the hostname (or reads a
literal IP directly), and denies loopback/private/link-local/CGNAT/multicast/reserved IPv4 ranges
and their IPv6 equivalents (`fc00::/7`, `fe80::/10`, `::1`, IPv4-mapped `::ffff:0:0/96` deferring to
the v4 check). `WEBHOOK_ALLOW_PRIVATE_NETWORKS=1` is the documented local-testing escape hatch.

**Fixed — redirect-based bypass.** The DNS-resolution check only ever validated `webhooks.url`
itself; the actual delivery `fetch()` call had no `redirect` option, so it followed the default
`"follow"` behavior. A receiver could register a public, guard-passing URL that responds `3xx` to
the real delivery POST with a `Location` pointing at a private address (`http://169.254.169.254/...`,
`http://127.0.0.1:<internal-port>/...`, etc.) and the server would transparently follow it,
completely bypassing the guard on the hop that actually matters. Closed by setting
`redirect: "manual"` on the delivery `fetch` (`webhooks/deliver.ts`) and treating any `3xx`
response as a failed delivery (retried with backoff, eventually dead-lettered) rather than
followed — a receiver that legitimately moves must be re-registered at its new URL. Covered by
`webhooks/deliver.test.ts`'s new "does not follow a redirect response (SSRF-via-redirect guard)"
case, using a local receiver that 302s to `127.0.0.1:1`.

## 6. Server-held signing keys (N/A)

VeriCell.net v1.1.0 removed the server-signed anchoring path entirely — every anchor and withdraw is
now non-custodial (prepare/sign/submit), so the API never holds a signing key at all and every
proof cell's lock is the caller's own wallet. See `docs/DECISIONS.md`'s "custodial mode removal"
entry for the rationale; this section's original findings no longer apply. **N/A.**

## 7. Mainnet guards

- **Every mainnet startup logs a prominent warning** (`packages/api/src/mainnetWarning.ts`'s
  `warnIfMainnet`, called from both `server/run.ts` and `indexer/run.ts` right after the logger is
  constructed), so a process accidentally pointed at `VERICELL_NETWORK=mainnet` logs a loud,
  unmissable `warn` before doing anything else. Covered by `mainnetWarning.test.ts`. **Pass.**
- **DB is network-scoped** (`vericell.<network>.sqlite` via `resolveDbPath`), so a testnet index
  can never be accidentally served as mainnet data or vice versa. **Pass.**
- **`/health`, `/stats` and CLI output all report the active network** (`app.network`,
  `NETWORK`/`isMainnet()` from `core`). **Pass.**

## Summary of changes made in this phase

| Finding | File(s) | Resolution |
|---|---|---|
| Webhook delivery followed redirects, bypassing the SSRF host check on the real request | `packages/api/src/webhooks/deliver.ts` | `redirect: "manual"`; 3xx treated as a failed delivery |
| No general "starting on mainnet" warning (only the custodial-specific refusal existed) | `packages/api/src/mainnetWarning.ts`, `server/run.ts`, `indexer/run.ts` | Added `warnIfMainnet`, called from both process entrypoints |

Everything else in this checklist was verified as already correct and is recorded above as
**Pass** or a named, reasoned **Accepted trade-off** rather than left unchecked.
