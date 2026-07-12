# VeriCell API image — also runs the indexer worker (same image, different
# command; see docker-compose.yml's `api` / `indexer-testnet` / `indexer-mainnet`
# services). Build context is the repo root (pnpm workspace), e.g.:
#   docker build -f packages/api/Dockerfile -t vericell-api .
#
# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
# better-sqlite3 has no prebuilt musl (Alpine) binary for every version, so
# it compiles from source on `pnpm install` — these are build-time only and
# do not appear in the runtime stage below.
RUN apk add --no-cache python3 make g++ \
    && corepack enable

WORKDIR /repo
# Manifests first (workspace layout + lockfile), so `pnpm install` is cached
# as long as no dependency changed, even if application source did.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/chain/package.json packages/chain/package.json
COPY packages/api/package.json packages/api/package.json
RUN pnpm install --frozen-lockfile

COPY packages/core packages/core
COPY packages/chain packages/chain
COPY packages/api packages/api
RUN pnpm --filter api... run build

# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
# better-sqlite3's compiled addon links libstdc++ at runtime even though it
# doesn't need the rest of the g++ toolchain.
#
# DB_DIR defaults to /data (docker-compose.yml's sqlite-data volume). A named
# volume with no prior content is initialized from whatever's at its mount
# path in the image at first use, ownership included — creating /data here
# (owned by vericell, before anything mounts over it) is what actually gets
# the non-root user write access to it, since an empty volume otherwise
# starts out root-owned.
RUN apk add --no-cache tini libstdc++ \
    && addgroup -S vericell && adduser -S vericell -G vericell \
    && mkdir -p /data && chown vericell:vericell /data

WORKDIR /app
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/package.json /repo/pnpm-workspace.yaml ./
COPY --from=build /repo/packages/core packages/core
COPY --from=build /repo/packages/chain packages/chain
COPY --from=build /repo/packages/api packages/api

ENV NODE_ENV=production
WORKDIR /app/packages/api
USER vericell

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O- http://127.0.0.1:3000/api/v1/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
# Overridden by the indexer services with ["node", "dist/indexer/run.js"].
CMD ["node", "dist/server/run.js"]
