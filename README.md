# VeriCell.net

Proof of authorship, integrity and time for any digital project, anchored in
a live cell on Nervos CKB — accessible through a web app and a REST API for
automation (CI/CD, GitHub Actions, scripts).

A SHA-256 hash published next to a download proves file integrity, but only
as long as the page hosting it is trusted and unchanged. VeriCell.net anchors a
hash manifest on-chain instead: the block timestamp proves *when*, the
cell's lock script proves *who* (only the owner can consume/supersede it),
and cell liveness proves *which version is current* — a consumed cell always
points forward to its successor. See `TECHNICAL.md` for the full design.

## Monorepo layout

```
packages/core   — pure logic: hashing, Merkle, manifest, network flag
packages/chain  — CKB layer (@ckb-ccc/ccc): tx building, Type ID, RPC
packages/api    — Fastify REST API + indexer worker + SQLite
packages/web    — the web app (Vite SPA)
packages/cli    — vericell command-line tool
scripts/        — service-fee pool setup/sweeping (docs/DEPLOY.md)
docs/           — TECHNICAL.md, DECISIONS.md, DEPLOY.md, SECURITY.md, openapi.json
```

## Dev quickstart

```bash
pnpm install
pnpm build
pnpm test

# web app only, against your own or no API
pnpm --filter web dev        # http://localhost:5173

# full stack against a local offckb devnet
npm i -g @offckb/cli
scripts/e2e.sh                # brings up devnet, indexer, API, drives the CLI
```

Everything defaults to **testnet**. Mainnet is opt-in only, via
`VERICELL_NETWORK=mainnet` (API/CLI) or `VITE_VERICELL_NETWORK=mainnet` (web
build) — see `TECHNICAL.md` §11.

## Running the full stack

```bash
cp .env.example .env   # fill in ADMIN_TOKEN, CADDY_DOMAIN, VITE_API_URL, ...
docker compose up -d --build
```

Brings up Caddy (static web + `/api` reverse proxy, automatic HTTPS for a
real domain), the dual-network API, and one indexer per network (testnet,
mainnet), all pointed at CKB's public RPC by default. See `docs/DEPLOY.md`
for the full VPS runbook — server hardening, DNS, the service-fee pool
setup, backups, and disaster recovery.

## Documentation

- [`TECHNICAL.md`](./TECHNICAL.md) — data model, manifest format, database
  schema, full REST API surface.
- [`docs/DEPLOY.md`](./docs/DEPLOY.md) — deployment runbook.
- [`docs/DECISIONS.md`](./docs/DECISIONS.md) — implementation decisions not
  already covered above.
- API docs: `/api/v1/docs` on any running deployment (OpenAPI 3.1 spec at
  `/api/v1/openapi.json`, also checked into `docs/openapi.json`).

## Service fee

VeriCell.net anchors are free of any service fee below 300 CKB of locked
capacity. At or above that, a 1% service fee applies on top of the locked
capacity. The locked capacity itself is never spent — it stays refundable to
you later, by withdrawing the proof cell or superseding it with a new
version. Only the service fee (when one applies) leaves your wallet for
good. A deployment with no fee address configured charges nothing at all —
see `TECHNICAL.md` §7.2-B and `docs/DEPLOY.md`'s fee-cell setup section.
