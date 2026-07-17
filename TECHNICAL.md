# VeriCell.net — Technical Documentation

Proof of authorship, integrity and time for any digital project, anchored in a live cell on Nervos CKB. Accessible through a web app **and** a REST API for automation (CI/CD, GitHub Actions, scripts).

> Note on naming: the hash algorithm is **SHA-256** (256-bit output of the SHA-2 family). "SHA254" in early notes refers to the same thing.

## 1. Problem statement

A SHA-256 hash published next to a download proves file integrity — but only as long as the web page itself is trusted and unchanged. It proves nothing about:

- **Time** — when the file first existed in that exact form
- **Author** — who published it (a hash has no owner)
- **Currency** — whether this is still the latest version, and where to find it

VeriCell.net solves all three by storing a hash **manifest** in a CKB cell:

| Property     | Provided by                                                        |
|--------------|--------------------------------------------------------------------|
| Integrity    | SHA-256 of every file + overall project hash + Merkle root          |
| Time         | Block header timestamp of the anchoring transaction (PoW-secured)   |
| Author       | The cell's lock script = the creator's wallet; only they can consume/update it |
| Currency     | Cell liveness: **live cell = current version**, consumed = superseded. The consuming transaction points to the successor. |
| Source       | `source` URL field in the manifest (immutable once anchored)        |

## 2. Architecture

```
┌─────────────────────────────┐     ┌──────────────────────────────────┐
│  Web SPA (Vite)             │     │  Automation clients               │
│  · Web Crypto SHA-256       │     │  · CLI (vericell)                │
│  · CCC wallet (JoyID, …)    │     │  · GitHub Action / CI pipelines   │
│  · builds & signs txs       │     │  · any HTTP client                │
└──────────┬──────────────────┘     └──────────────┬───────────────────┘
           │ read: search/verify                   │ REST (API key)
           ▼                                       ▼
┌──────────────────────────────────────────────────────────────────────┐
│  VeriCell API service (Node/Fastify)                                │
│  · REST API  /api/v1  (OpenAPI 3.1)                                  │
│  · Indexer worker: follows the chain, parses manifests               │
│  · DB (SQLite → PostgreSQL): projects / versions / hashes            │
└──────────┬───────────────────────────────────────────────────────────┘
           │ RPC (CKB node / public RPC)
           ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Nervos CKB — proof cells: lock = owner, data = manifest             │
└──────────────────────────────────────────────────────────────────────┘
```

The chain is the source of truth. The database is **derived state** — anyone can rebuild it from the chain, so users never have to trust the VeriCell.net server. The web app can operate without the API (direct RPC + local index); the API adds global search and automation.

Package note: the CCC repository is `github.com/ckb-devrel/ccc`; the npm package is **`@ckb-ccc/ccc`**.

## 3. On-chain manifest (cell data)

```json
{
  "app": "vericell",
  "v": 1,
  "title": "EasyTransfer v1.4.0",
  "created": "2026-07-10T12:00:00Z",
  "source": "https://github.com/you/easytransfer",
  "project_sha256": "…64 hex…",
  "merkle_root": "…64 hex…",
  "count": 42,
  "files": [ { "p": "src/main.js", "h": "…64 hex…" }, … ],
  "genesis": "0x…",   // tx hash of the first version = project UNID (versions ≥ 2)
  "prev": "0x…"       // tx hash of the directly preceding version (versions ≥ 2)
}
```

- `project_sha256` = SHA-256 over the canonical string `sort_by_path(path + "\n" + hash + "\n")` — reproducible by anyone from the file list.
- `merkle_root` = binary Merkle tree over the sorted leaf hashes (odd leaf duplicated). Enables **compact mode**: omit `files`, store only the root. Individual files are then proven with a Merkle path kept off-chain (e.g. shipped as `vericell.json` inside the release).
- Cost: 1 CKB = 1 byte of cell space, plus 61 CKB minimum cell overhead. Full manifest ≈ `(90 bytes header + ~110 bytes/file)` CKB; compact mode ≈ 300 CKB regardless of project size. **Capacity is locked, not burned** — consuming the cell returns it.

## 4. Versioning via cell consumption

CKB cells are immutable; updating means consuming the old cell and creating a new one in the same transaction:

```
tx1: ∅ ──────────────► Cell v1 (live)          genesis = tx1
tx2: Cell v1 (input) ─► Cell v2 (live)         prev = tx1, genesis = tx1
tx3: Cell v2 (input) ─► Cell v3 (live)         prev = tx2, genesis = tx1
```

- Only the lock owner can sign the consuming transaction → only the author can publish a successor.
- A verifier holding an old file still finds its proof in the **dead** cell (history is never deleted on CKB), sees it is superseded, and follows the consuming transaction forward to the current live cell.
- Withdrawing a project = consuming the cell without creating a successor (capacity refunds to the owner).

## 5. Project identity (UNID)

- **v1:** UNID = the tx hash of the first version; later versions carry it in `genesis`. The `prev` links are verifiable on-chain because the consuming tx literally spends the previous cell.
- **Production:** attach CKB's built-in **Type ID** type script to the proof cell. The type script args become a globally unique, *stable* identifier that survives every consume-and-recreate cycle and enforces that only one live cell per project exists. CCC exposes `ccc.hashTypeId(input, outputIndex)`. Type ID also makes indexing trivial: query live cells by type script.

## 6. Database (indexer-maintained)

SQLite for a single-node deployment, PostgreSQL for scale — identical schema:

```sql
CREATE TABLE projects (
  unid          TEXT PRIMARY KEY,     -- type ID args (or genesis tx hash)
  title         TEXT NOT NULL,
  source_url    TEXT,
  ckb_address   TEXT NOT NULL,        -- owner lock as address
  created_at    TIMESTAMPTZ NOT NULL, -- block timestamp of first version
  active        BOOLEAN NOT NULL,     -- true while a live cell exists
  live_tx_hash  TEXT,
  live_index    INTEGER DEFAULT 0
);

CREATE TABLE versions (
  tx_hash        TEXT PRIMARY KEY,
  unid           TEXT REFERENCES projects(unid),
  version_no     INTEGER,
  prev_tx_hash   TEXT,
  project_sha256 TEXT NOT NULL,
  merkle_root    TEXT,
  block_number   BIGINT,
  block_time     TIMESTAMPTZ,
  status         TEXT NOT NULL        -- pending | committed | consumed
);

-- backward search: any file hash → project (the "SHA-256 list" requirement)
CREATE TABLE hashes (
  sha256   TEXT NOT NULL,
  tx_hash  TEXT REFERENCES versions(tx_hash),
  path     TEXT,
  PRIMARY KEY (sha256, tx_hash, path)
);
CREATE INDEX idx_hashes_sha ON hashes (sha256);

CREATE TABLE api_keys (
  key_hash    TEXT PRIMARY KEY,       -- store only the hash of the key
  label       TEXT,
  created_at  TIMESTAMPTZ,
  rate_limit  INTEGER DEFAULT 60
);

CREATE TABLE webhooks (
  id        TEXT PRIMARY KEY,
  key_hash  TEXT REFERENCES api_keys(key_hash),
  unid      TEXT,                     -- NULL = all projects of this key
  url       TEXT NOT NULL,
  events    TEXT NOT NULL             -- committed,consumed,superseded
);

CREATE TABLE sync_state (             -- indexer cursor, reorg-safe
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_block_number BIGINT,
  last_block_hash   TEXT
);
```

The **indexer worker** follows the chain (CKB indexer RPC, filtered by the VeriCell.net type script once Type ID is deployed), parses manifests, maintains these tables, and handles reorgs by rolling back to the fork point using `sync_state`.

## 7. REST API (`/api/v1`)

OpenAPI 3.1 spec served at `/api/v1/openapi.json`, interactive docs at `/api/v1/docs`. JSON everywhere; errors follow RFC 9457 (`application/problem+json`).

### 7.1 Public endpoints — no authentication (mirrors the "no login to search/verify" rule)

| Method | Path | Purpose |
|---|---|---|
| GET | `/projects` | Search. Query params: `q` (title), `hash` (any SHA-256), `address`, `active`, `page`, `limit` |
| GET | `/projects/{unid}` | Project record + current live version + full version chain |
| GET | `/versions/{txHash}` | One version: manifest, chain status (live/consumed), block number & timestamp, owner |
| GET | `/hashes/{sha256}` | Backward search: every project/version/path containing this file hash |
| GET | `/verify/{sha256}` | Convenience verdict: `{ found, live, project, version, block_time, path }` |
| GET | `/stats` | Totals: projects, versions, hashes indexed, sync height |
| GET | `/health` | Liveness + indexer lag |

Verification never uploads files: clients hash locally (CLI, browser, `sha256sum`) and query by hash.

### 7.2 Authenticated endpoints — `Authorization: Bearer <api-key>`

Non-custodial only: the API prepares an unsigned transaction, the client signs it locally and submits the result — the API never holds a private key, and every proof cell's lock is the caller's own wallet. This single flow covers all three transaction shapes a project's lifecycle needs:

| Method | Path | Purpose |
|---|---|---|
| POST | `/proofs/prepare` | Body is one of: a manifest draft (+ optional `prev_tx_hash` for a new version, + payer lock) for an anchor, or `{ withdraw_tx_hash }` for a withdraw. Returns an **unsigned CKB transaction skeleton** — for an anchor, also the exact capacity required and a `cost` breakdown (locked capacity, network fee, service fee — see §7.2-B); for a withdraw, the refund capacity. |
| POST | `/proofs/submit` | Body: the signed transaction (anchor or withdraw — the API tells them apart by whether output 0 carries manifest bytes). API broadcasts it; an anchor creates a `pending` version row and returns `tx_hash`/`unid`; a withdraw clears the project's live version and returns `tx_hash`/`unid`/`refund_capacity`. |

The user's key never leaves their machine; the CLI wraps both calls around a local CCC signer for `anchor` and `withdraw` alike. All mutating endpoints accept an `Idempotency-Key` header — retries never double-anchor.

### 7.2-B Service fee

VeriCell.net may charge a service fee on top of the locked capacity: **1% of the new proof cell's locked capacity, waived entirely below 300 CKB**, floored to the nearest shannon. The fee is per-network config only — `VERICELL_FEE_ADDRESS_TESTNET` / `VERICELL_FEE_ADDRESS_MAINNET` (server; `VITE_`-prefixed for the web build) — and is fully inert on any network where the corresponding variable is unset (no fee address is ever hardcoded in this repo).

The fee applies to **every transaction that creates a new proof cell**, regardless of origin — a first anchor or a new version, whether built by the web app, the CLI, or any other API-prepared transaction. `POST /proofs/prepare` always builds the fee leg into the returned transaction and reports it in the `cost` field; `POST /proofs/submit` independently recomputes the fee due from the signed transaction's own output capacity and rejects (`402 Payment Required`) a transaction that doesn't actually pay it, for both the first-anchor and new-version paths — a client cannot skip the fee by stripping the leg before signing. Withdrawals create no new proof cell and so carry no service fee at all — `/proofs/prepare`'s withdraw response has no `cost` field, and `/proofs/submit` never requires one for a withdraw transaction.

Mechanically, the fee is collected by topping up a pool of pre-funded ACP (anyone-can-pay, [RFC 0026](https://github.com/nervosnetwork/rfcs/blob/master/rfcs/0026-anyone-can-pay/0026-anyone-can-pay.md)) cells owned by the configured address: a small fee can't be sent as its own output (CKB cells have a ~61 CKB minimum), so instead the anchoring transaction spends one of the operator's pool cells as both an input and an output, its capacity increased by the fee — a capacity *increase* at an ACP lock needs no signature from the fee recipient.

Operators set up and maintain the pool with `scripts/create-fee-cells.ts` (including a `--print-acp-address` mode to derive the collection address for a given owner address, with no key or broadcast involved) and consolidate accumulated fees back out with `scripts/sweep-fee-cells.ts` — see `docs/DEPLOY.md`.

### 7.3 Webhooks

| Method | Path | Purpose |
|---|---|---|
| POST | `/webhooks` | Register `{ url, events, unid? }`. Events: `committed` (tx confirmed), `consumed`, `superseded` (new version live) |
| DELETE | `/webhooks/{id}` | Remove |

Deliveries are signed with an HMAC header (`X-VeriCell-Signature`) so receivers can authenticate the callback.

### 7.4 Rate limiting & keys

Public endpoints: per-IP limit (e.g. 60 req/min). Keyed endpoints: per-key limit from `api_keys.rate_limit`. Keys are shown once at creation and stored only as hashes.

### 7.5 Example automation flow (CI release)

```bash
# in a GitHub Action, after building release artifacts
vericell hash ./dist --out manifest.json
vericell anchor manifest.json \
  --api https://api.vericell.example/api/v1 \
  --key $VERICELL_API_KEY \
  --signer-key-file ./ci-ckb-key
# poll or receive webhook: status pending → committed
vericell status <unid>
```

## 8. Input sources (web app)

| Source        | Method                                                                      |
|---------------|------------------------------------------------------------------------------|
| Local files   | `<input type="file" multiple>` + drag-and-drop, hashed via `crypto.subtle`   |
| Folder        | `<input webkitdirectory>` preserving relative paths                          |
| GitHub repo   | GitHub API tree + `raw.githubusercontent.com` (CORS-enabled), ≤ 200 files    |
| URL           | direct `fetch` — works only where the server sends CORS headers              |
| Paste hashes  | for artifacts hashed elsewhere (`sha256sum`, CI pipelines, ZIP archives)     |

## 9. Security & limitations

- **Proof of knowledge, not authorship in the legal sense.** The chain proves the wallet owner knew the hashes at block time — first-to-anchor wins. Anchor *before* publishing.
- **Manifest timestamps are claims; block timestamps are authoritative.** Both are shown, labeled.
- **Every anchor is non-custodial.** The API never holds a signing key; every proof cell's lock is the caller's own wallet, so only the author can consume/supersede it.
- **API keys** are bearer secrets: hashed at rest, never logged, revocable, per-key rate limits.
- **CORS** limits the URL source in-browser; the CLI or API-side fetching covers server-to-server cases.
- **JSON in cell data** is readable but not the cheapest encoding; Molecule (CKB's canonical serialization) would cut size ~30% — natural v2 format.
- Anchoring a false manifest is possible — verification always means recomputing hashes from real files, never trusting a title.

## 10. Roadmap

1. Type ID type script (stable UNID + trivial indexing)
2. Public indexer + REST API (this document, §6–7)
3. CLI + GitHub Action for CI/CD anchoring
4. Molecule-encoded manifests; optional compression of the file table
5. Off-chain Merkle-path files (`vericell.json`) inside releases for compact mode
6. Secondary OpenTimestamps anchor of `project_sha256` to Bitcoin for cross-chain redundancy
7. DID/signature layer so authorship survives wallet rotation

## 11. Running it

```bash
# web app (v1, standalone)
npm install && npm run dev        # http://localhost:5173

# full stack (once built per ClaudeCodeInstruction.md)
docker compose up                 # API + indexer + DB, web served statically
```

### Network flag

The target chain is a single constant resolved from the environment, defined once in `packages/core/src/network.ts` and imported by every package:

| Variable | Where | Values | Default |
|---|---|---|---|
| `VERICELL_NETWORK` | API, indexer, CLI (runtime) | `devnet` \| `testnet` \| `mainnet` | `testnet` |
| `VITE_VERICELL_NETWORK` | web app (baked at build time) | same | `testnet` |

Testing and staging always run on **testnet** (test CKB: faucet.nervos.org); automated tests use a local **devnet** (offckb). Deploying online to **mainnet** means setting the variable at deploy time — no code changes. Safeguards: the DB file is network-scoped (`vericell.<network>.sqlite`), the active network is shown in the web top bar, `/health`, `/stats` and CLI output, and every mainnet startup logs a prominent warning.

Wallets: JoyID via CCC; every other CCC signer plugs into the same `Signer` interface.
