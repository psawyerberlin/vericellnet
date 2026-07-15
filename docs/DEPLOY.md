# Deploying VeriCell

A from-scratch runbook for taking a fresh VPS to a running `vericell.net` — the
`docker-compose.yml` stack described in `ClaudeCodeInstruction.md` Phase 10 and
`docs/DECISIONS.md`'s Phase 10c entry. Read `TECHNICAL.md` §11 and the top of
`docker-compose.yml` first for the shape of the stack: one dual-network `api`
container (serves testnet **and** mainnet at once), one single-network
`indexer-testnet` and one `indexer-mainnet` container, and `caddy` in front
serving the built web app and reverse-proxying `/api/*`.

## 1. Provision the server

Any small VPS (1 vCPU / 2 GB RAM is enough — the API/indexer are lightweight;
Caddy and SQLite need very little) running a current Debian or Ubuntu LTS.

```bash
# as root, on a fresh box
apt update && apt -y upgrade

# unattended security updates
apt -y install unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades

# a non-root deploy user with sudo and docker access (assigned once the
# docker group exists, below)
adduser deploy
usermod -aG sudo deploy

# firewall: SSH, HTTP, HTTPS only
apt -y install ufw
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
```

Log out and back in as `deploy` for the rest of this guide.

## 2. Install Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
# log out/in again (or `newgrp docker`) to pick up the group membership
docker compose version   # bundled with current Docker as `docker compose`
```

## 3. DNS

Point an A record (and AAAA, if the VPS has IPv6) for `vericell.net` at the
server's public IP before starting Caddy with the real domain — automatic
HTTPS needs the ACME HTTP-01/TLS-ALPN challenge to reach the box on the
hostname it's requesting a certificate for. If DNS isn't ready yet, start
with `CADDY_DOMAIN=:80` (see step 5) and switch it once the record propagates.

## 4. Clone and configure

```bash
git clone <your fork/remote> vericell
cd vericell
cp .env.example .env
```

Edit `.env`:

- `CADDY_DOMAIN=vericell.net` (or `:80` for now, see step 3).
- `VITE_API_URL=https://vericell.net` — same origin, since Caddy proxies
  `/api/*` to the `api` service; use `http://<server-ip>` if testing over
  plain HTTP before DNS is live.
- `ADMIN_TOKEN` — generate one: `openssl rand -hex 32`.
- Leave `VERICELL_RPC_URL` unset to use CKB's public endpoints (the
  production default) unless you're running your own node.
- `INDEXER_START_BLOCK_TESTNET` / `INDEXER_START_BLOCK_MAINNET` — set these
  to VeriCell's actual first-anchor block height on each network once you
  know it, so a fresh deploy doesn't walk the whole chain from genesis. `0`
  is fine for a first deploy.
- Fee variables — leave every `VERICELL_FEE_ADDRESS_*`/`VITE_VERICELL_FEE_ADDRESS_*`
  unset until you've done the fee-cell setup below; an unset pair means fee
  collection is simply off, anchoring still works normally.

## 5. Fee-cell setup

Skip this section entirely if you don't want to charge the service fee —
every fee variable left unset (the `.env.example` default) means
`packages/core`'s `getFeeAddress` returns `undefined` and the fee logic never
runs: no ACP lookups, no fee leg on any transaction, nothing for
`POST /proofs/submit` to enforce (TECHNICAL.md §7.2-B).

The fee is collected by topping up a small pool of pre-funded ACP
(anyone-can-pay) cells you own — a capacity *increase* at an ACP lock needs no
signature from you, so the anchoring transaction itself can pay in without
your involvement. `scripts/create-fee-cells.ts` sets the pool up;
`scripts/sweep-fee-cells.ts` (step 8) consolidates what accumulates.

Build the scripts package once (from a clone with `pnpm install` already run):

```bash
pnpm --filter scripts build
```

**a. Derive the ACP address for your own wallet**, per network — reads no key,
sends nothing:

```bash
node scripts/dist/create-fee-cells.js --print-acp-address <your-own-ckb-address> --network testnet
node scripts/dist/create-fee-cells.js --print-acp-address <your-own-ckb-address> --network mainnet
```

Each prints one address. Put those in `.env` as `VERICELL_FEE_ADDRESS_TESTNET`
/ `VERICELL_FEE_ADDRESS_MAINNET` (and the matching `VITE_VERICELL_FEE_ADDRESS_*`
pair for the web build) before continuing — the next command reads them back
out of the same env var to confirm it's deriving the address you expect.

**b. Fund the pool** — 3 cells of 100 CKB each is the default and matches
`sweep-fee-cells`'s own default reserve (step 8), so ordinary sweeps leave the
pool at full strength automatically:

```bash
# put the payer's hex-encoded private key in a file first, e.g.:
#   echo 0xYOUR_PRIVATE_KEY > /tmp/payer.key && chmod 600 /tmp/payer.key
node scripts/dist/create-fee-cells.js --network testnet --key-file /tmp/payer.key
node scripts/dist/create-fee-cells.js --network mainnet --key-file /tmp/payer.key
rm -f /tmp/payer.key
```

Defaults shown above are `--count 3 --capacity-ckb 100`; override either flag
if you want a different pool size. `--fee-address <addr>` overrides the env
var for a single run if you ever need to point at a different collection
address without editing `.env`.

**ckb-cli alternative for step (a):** the ACP addresses above are ordinary
addresses under CKB's standard AnyoneCanPay lock script (`hash_type: "type"`,
`code_hash` `0x3419a1c09eb2567f6552ee7a8ecffd64155cffe0f1796e6e61ec088d740c1356`
on testnet, `0xd369597ff47f29fbc0d47d2e3775370d1250b85140c670e4718af712983a2354`
on mainnet — read live from CCC's known-scripts registry, not hardcoded
guesses), with the same 20-byte blake160 `args` as your regular secp256k1
address. If you'd rather derive this with `ckb-cli` than trust our script:
get your own lock's `args` (`ckb-cli util key-info` / decode your address),
then construct an address from that `args` under the code hash above. We
haven't pinned an exact `ckb-cli` invocation for the second half here — its
address-construction subcommands vary by version — so treat
`--print-acp-address` above as the verified path and use this only to
cross-check its output.

## 6. Build and start

Validate `packages/web/Caddyfile` before building — a syntax error there
doesn't fail the build, it crash-loops the `caddy` container after `up -d`,
which is a much slower way to find out:

```bash
docker run --rm -v $(pwd)/packages/web/Caddyfile:/etc/caddy/Caddyfile:ro \
  -e CADDY_DOMAIN=:80 -e STATS_TOKEN=x caddy:2-alpine \
  caddy validate --config /etc/caddy/Caddyfile
```

Must print `Valid configuration`. Then:

```bash
docker compose up -d --build
docker compose ps
```

First build compiles `core`/`chain`/`api` (TypeScript) and the web app (Vite)
inside Docker — expect a few minutes on a small VPS. Caddy requests its
certificate on first request once `CADDY_DOMAIN` is a real hostname; watch
`docker compose logs -f caddy` if it doesn't come up within a minute or two.

## 7. Verify

```bash
curl https://vericell.net/api/v1/testnet/health
curl https://vericell.net/api/v1/mainnet/health
curl -I https://vericell.net/               # web app, and a valid TLS cert
```

Each `/health` response reports indexer lag for that network — expect it to
shrink from `null`/large towards `0` as `indexer-testnet`/`indexer-mainnet`
catch up from `INDEXER_START_BLOCK_*`. `docker compose logs -f api
indexer-testnet indexer-mainnet` to watch it happen.

## 8. Maintenance

**Backups.** The only state that matters is the `sqlite-data` volume — it's
entirely rebuildable from the chain (see "Disaster recovery" below), but a
backup is still far faster than a resync. `better-sqlite3` runs in WAL mode,
so back up the whole directory, not just the main file:

```bash
# cron, e.g. daily — dumps via the sqlite3 CLI's .backup (safe on a live WAL
# DB, unlike a raw file copy) into a tarball, then ships it off the VPS.
docker compose exec api sh -c '
  for n in testnet mainnet; do
    sqlite3 "/data/vericell.$n.sqlite" ".backup /tmp/vericell.$n.bak"
  done'
docker compose cp api:/tmp/vericell.testnet.bak ./backups/
docker compose cp api:/tmp/vericell.mainnet.bak ./backups/
# then rsync/rclone ./backups/ to storage that isn't this VPS.
```

**Sweeping fees.** Run whenever you want to consolidate accumulated fee
capacity out of the pool cells to your own wallet (the reserve — default 100
CKB, matching the pool's seed capacity — is left behind so collection keeps
working):

```bash
node scripts/dist/sweep-fee-cells.js --network testnet --key-file /tmp/owner.key
node scripts/dist/sweep-fee-cells.js --network mainnet --key-file /tmp/owner.key
rm -f /tmp/owner.key
```

The key file must be the fee address's own key — sweeping spends an
ACP-locked cell below its full capacity, which (unlike the top-up itself)
does need the recipient's real signature.

**Updating.**

```bash
git pull
docker compose up -d --build
```

Compose rebuilds only what changed and restarts affected containers;
`sqlite-data`/`caddy-data`/`caddy-config` volumes are untouched.

**Logs.** Every service ships with `json-file` logging capped at 10 MB × 3
files (`docker-compose.yml`'s `x-logging` anchor), so `docker compose logs`
output is self-bounding — no separate logrotate setup needed for container
logs. `docker compose logs -f <service>` to tail one.

## 9. Disaster recovery

The database is derived state — TECHNICAL.md §2: "anyone can rebuild it from
the chain." If `sqlite-data` is lost or corrupted with no backup:

```bash
docker compose down
docker volume rm vericell_sqlite-data
# set INDEXER_START_BLOCK_TESTNET/_MAINNET in .env to VeriCell's actual
# first-anchor height on each network, so the resync doesn't walk from
# genesis
docker compose up -d
```

Both indexers rebuild `projects`/`versions`/`hashes` purely from on-chain
data; nothing anchored is lost, only the time it takes to resync.

## Files containing the domain name

`vericell.net` appears in (verified with `grep -rl vericell.net .`):

- `.env.example` (`CADDY_DOMAIN`, `VITE_API_URL`)
- `docker-compose.yml` (the `CADDY_DOMAIN`/`VITE_API_URL` default fallbacks)
- `packages/web/Caddyfile` (a comment explaining `{$CADDY_DOMAIN}`, not a hardcoded value)
- `packages/web/Dockerfile` (an example `docker build` invocation in a comment)
- `docs/DEPLOY.md` (this file)

Changing domains means updating `.env.example`/`.env` and this file, and
re-running `docker compose up
-d --build` (a new cert is requested automatically on first request under the
new hostname). `packages/core/src/network.ts` and everywhere else in the
codebase never hardcode it — the network-flag rule in
`ClaudeCodeInstruction.md` applies to RPC/explorer URLs, not the operator's
own domain, but it's worth the same discipline: nothing under `packages/`
references this domain directly.
