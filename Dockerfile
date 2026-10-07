# syntax=docker/dockerfile:1
# Standalone happy-server: single container, no external dependencies
# Uses PGlite (embedded Postgres), local filesystem storage, no Redis
#
# The runtime image holds one bundled JS file, the PGlite wasm, the migrations
# and Prisma's query engine (see packages/happy-server/scripts/build-standalone-bundle.cjs).
# No node_modules, no pnpm, no ffmpeg/curl.

# Builder and runtime must share a base: the Prisma engine is picked for the
# builder's platform (libc + OpenSSL) and has to load in the runtime.
ARG NODE_IMAGE=node:20-alpine

# bun builds the bundle. Copied from its official image rather than installed
# with npm, so the binary is pinned and matches the builder's arch and libc.
FROM oven/bun:1.4.2-alpine AS bun

# Stage 1: install, type-check and bundle. On the runtime's base image,
# `prisma generate` fetches the engine the runtime needs
# (linux-musl-openssl-3.0.x, or its arm64 twin) with no cross-target setup.
FROM ${NODE_IMAGE} AS builder

RUN corepack enable && corepack prepare pnpm@10.11.0 --activate
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /repo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY scripts/postinstall.cjs ./scripts/
COPY patches ./patches
COPY packages/happy-wire/package.json packages/happy-wire/
COPY packages/happy-server/package.json packages/happy-server/
COPY packages/happy-server/prisma packages/happy-server/prisma

# With node-linker=hoisted pnpm installs the whole lockfile (app deps
# included) even under --filter. --ignore-scripts keeps the app's native
# install steps (better-sqlite3's node-gyp fallback, skia) out of an image that
# has no compiler; nothing from this node_modules reaches the runtime anyway.
# Then run the two install steps the server does need:
# - root postinstall: applies patches/; the bundle inlines pglite-prisma-adapter,
#   so its Bytes fix must be on disk before bundling
# - prisma generate: the client, plus the query engine for this platform
RUN pnpm install --frozen-lockfile --ignore-scripts \
    && SKIP_HAPPY_WIRE_BUILD=1 node scripts/postinstall.cjs \
    && pnpm --filter happy-server --fail-if-no-match run generate

COPY packages/happy-wire ./packages/happy-wire
COPY packages/happy-server ./packages/happy-server

RUN pnpm --filter @slopus/happy-wire --fail-if-no-match build
# Type-check gate: bun strips types without checking them.
RUN pnpm --filter happy-server --fail-if-no-match build
RUN node packages/happy-server/scripts/build-standalone-bundle.cjs --out /out

# Stage 2: runtime
FROM ${NODE_IMAGE} AS runner

# PRISMA_QUERY_ENGINE_LIBRARY: the bundled Prisma client cannot find the
# engine on its own (bun pins its __dirname to the builder's paths).
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PGLITE_DIR=/data/pglite \
    PRISMA_QUERY_ENGINE_LIBRARY=/app/libquery_engine.so.node

# Owned by root and read-only to the server; only /data is writable.
WORKDIR /app
COPY --from=builder /out /app

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3005

# /health runs `SELECT 1`, so this goes healthy only once the API and the
# database are both up. -Y off: a proxy set in the container env must not
# intercept a loopback check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s --retries=3 \
    CMD wget -q -Y off -T 4 -O /dev/null "http://127.0.0.1:${PORT:-3005}/health" || exit 1

# cwd must be /app: migrate reads prisma/migrations and the server reads
# pglite.wasm/pglite.data from it. exec makes node PID 1 so it gets SIGTERM
# directly and runs its graceful shutdown.
CMD ["sh", "-c", "node standalone.mjs migrate && exec node standalone.mjs serve"]
