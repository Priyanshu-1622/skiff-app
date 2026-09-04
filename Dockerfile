# =====================================================
# Skiff — multi-stage Dockerfile
#
# Stage 1: base  — Node 20 + pnpm + build tools
# Stage 2: deps  — install all workspace deps
# Stage 3: build-shared — compile @skiff/shared to dist/
# Stage 4: build-web    — compile React frontend
# Stage 5: build-api    — compile Fastify API
# Stage 6: runtime      — minimal image, no build tools
#
# FIX: @skiff/shared was previously copied as raw .ts source into
# the runtime image. Plain `node` can't load .ts files, causing:
#   ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".ts"
# We now compile shared to JS first and copy only dist/.
# =====================================================

# ─── 1. base ────────────────────────────────────────────────
FROM node:20-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable && corepack prepare pnpm@9 --activate
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ─── 2. deps ────────────────────────────────────────────────
# Every workspace manifest is copied, including the desktop app's. pnpm
# validates the lockfile against the whole workspace, so a missing manifest
# fails --frozen-lockfile even for a project this image never builds.
#
# The install is filtered to the server so Electron isn't downloaded into a
# container that will never open a window.
FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/web/package.json ./apps/web/
COPY apps/api/package.json ./apps/api/
COPY apps/desktop/package.json ./apps/desktop/
COPY packages/shared/package.json ./packages/shared/
COPY packages/core/package.json ./packages/core/
RUN pnpm install --frozen-lockfile --filter @skiff/api... --filter @skiff/web...

# ─── 3. build packages ──────────────────────────────────────
# Compile @skiff/shared and @skiff/core to plain JS so the runtime stage has
# no .ts files to trip over. @skiff/core is the engine the API imports — SSH
# sessions, vault, recorder, audit — and it must be built before the API can
# typecheck against it. Both build-web and build-api inherit from this stage.
FROM deps AS build-shared
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/core ./packages/core
RUN pnpm --filter @skiff/shared build && pnpm --filter @skiff/core build

# ─── 4. build web ───────────────────────────────────────────
FROM build-shared AS build-web
COPY apps/web ./apps/web
# The web app imports the IPC contract types from the desktop app by relative
# path (apps/web/src/lib/api-ipc.ts), so those sources must exist for tsc even
# though nothing here runs Electron. Type-only imports vanish at runtime, so
# this adds nothing to the image — but without it the build fails in Docker
# while working perfectly on a developer machine, which is the worst kind of
# breakage to discover.
#
# The cleaner fix is to move those types into @skiff/shared, where both apps
# can import them without reaching across app boundaries. Worth doing, but it
# touches every call site and shouldn't be rushed.
COPY apps/desktop/src/shared ./apps/desktop/src/shared
RUN pnpm --filter @skiff/web build

# ─── 5. build api ───────────────────────────────────────────
FROM build-shared AS build-api
COPY apps/api ./apps/api
RUN pnpm --filter @skiff/api build

# ─── 6. runtime ─────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
    SKIFF_DATA_DIR=/app/data \
    SKIFF_HOST=0.0.0.0 \
    SKIFF_PORT=8080
WORKDIR /app

# better-sqlite3 needs libstdc++6 at runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9 --activate

# Install prod-only deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY apps/desktop/package.json ./apps/desktop/
COPY packages/shared/package.json ./packages/shared/
COPY packages/core/package.json ./packages/core/
RUN pnpm install --frozen-lockfile --prod --filter @skiff/api...

# Copy compiled artifacts
COPY --from=build-api /app/apps/api/dist ./apps/api/dist
COPY --from=build-web /app/apps/web/dist ./apps/web/dist
# Compiled JS for both packages, not raw .ts source.
#
# The old build also copied apps/api/src/db/schema.sql into dist. That file is
# no longer read at runtime: the schema was inlined into @skiff/core as a
# TypeScript constant when the engine was extracted, because readFileSync
# breaks inside an Electron asar archive. The copy is gone rather than left as
# a line nobody dares delete.
COPY --from=build-shared /app/packages/shared/dist ./packages/shared/dist
COPY --from=build-shared /app/packages/core/dist ./packages/core/dist

# Data volume — pre-create with correct ownership so non-root user can write
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/server.js"]
