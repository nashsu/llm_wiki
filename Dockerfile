# LLM Wiki — web client + backend server container.
#
# Build:   docker build -t llm-wiki .
# Run:     docker run -p 3000:3000 -v llm-wiki-data:/data llm-wiki
# Compose: docker compose up --build
#
# Stage 1 (builder) compiles the browser SPA (npm run build:web → dist-web/).
# Stage 2 (deps) produces a production-only node_modules (no vite/tsc/tauri).
# Stage 3 (runtime) is a slim image that serves the SPA + the HTTP/SSE API.

# ── Stage 1: build the SPA ──────────────────────────────────────────────────
FROM node:22-slim AS builder

# better-sqlite3 may have no prebuilt binary for this base image, so node-gyp
# compiles it from source during `npm ci`. Provide the C/C++ toolchain.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install the full dependency tree (devDependencies are needed to run the
# vite/typescript build). Lockfile-first for reproducible, cached layers.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
RUN npm ci

# Copy the rest of the source and build. build:api-types must run first: the
# server imports the built @llm-wiki/api-types package at runtime, and the web
# build typechecks against its .d.ts.
COPY . .
RUN npm run build:api-types && npm run build:web

# ── Stage 2: production dependencies ────────────────────────────────────────
FROM node:22-slim AS deps

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
# Production-only tree (drops vite/tsc/tauri/vitest) so the runtime stays small.
# Native modules (better-sqlite3) are compiled here against the node:22 ABI,
# which matches the runtime stage exactly.
RUN npm ci --omit=dev && npm cache clean --force

# ── Stage 3: runtime ────────────────────────────────────────────────────────
FROM node:22-slim AS runtime

# curl is required by the docker-compose health check.
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    LLM_WIKI_HOST=0.0.0.0 \
    LLM_WIKI_PORT=3000 \
    LLM_WIKI_DATA_DIR=/data

WORKDIR /app

# Server source (+ any nested modules), hoisted production dependencies, and the
# static SPA produced by the build stage. The server imports the built
# @llm-wiki/api-types package (node_modules holds a symlink to it), so the
# built package ships too — from the builder, since the deps stage is
# production-only and cannot run tsc.
COPY --from=deps /app/packages/server ./packages/server
COPY --from=builder /app/packages/api-types ./packages/api-types
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist-web ./dist-web

EXPOSE 3000

# SQLite database (server.db) + plugin stores live here; persist across runs.
VOLUME ["/data"]

CMD ["node", "packages/server/src/index-v2.js"]
