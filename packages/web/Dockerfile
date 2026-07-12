# VeriCell web image — builds the static SPA and serves it (plus reverse
# proxying /api to the `api` compose service) with Caddy, which also handles
# automatic HTTPS for a real domain. Build context is the repo root, e.g.:
#   docker build -f packages/web/Dockerfile \
#     --build-arg VITE_VERICELL_NETWORK=mainnet \
#     --build-arg VITE_API_URL=https://vericell.net \
#     -t vericell-web .
#
# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/web/package.json packages/web/package.json
RUN pnpm install --frozen-lockfile

COPY packages/core packages/core
COPY packages/web packages/web

# Vite only inlines VITE_-prefixed vars that are actually present in
# `process.env` (or a .env file) at build time — see core/src/network.ts and
# fee.ts for why these must be read as direct `import.meta.env.VITE_X`
# accesses, not aliased through a variable, for the replacement to happen.
ARG VITE_VERICELL_NETWORK=mainnet
ARG VITE_API_URL
ARG VITE_VERICELL_FEE_ADDRESS_TESTNET
ARG VITE_VERICELL_FEE_ADDRESS_MAINNET
ENV VITE_VERICELL_NETWORK=${VITE_VERICELL_NETWORK} \
    VITE_API_URL=${VITE_API_URL} \
    VITE_VERICELL_FEE_ADDRESS_TESTNET=${VITE_VERICELL_FEE_ADDRESS_TESTNET} \
    VITE_VERICELL_FEE_ADDRESS_MAINNET=${VITE_VERICELL_FEE_ADDRESS_MAINNET}

RUN pnpm --filter web... run build

# ---------------------------------------------------------------------------
FROM caddy:2-alpine
COPY --from=build /repo/packages/web/dist /srv/web
COPY packages/web/Caddyfile /etc/caddy/Caddyfile
