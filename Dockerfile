# LLM Wiki — self-hosted web server image
#
#   docker build -t llm-wiki .
#   docker run -p 8080:8080 -e LLM_WIKI_WEB_PASSWORD=change-me \
#     -v llm-wiki-data:/data -v $HOME/wikis:/wikis llm-wiki
#
# Data (settings, agent sessions, uploads) lives in /data; put wiki projects
# under a mounted folder such as /wikis and create/open them from the UI.

# ── frontend ────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS frontend
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig*.json vite.config.ts index.html components.json ./
COPY src ./src
COPY mcp-server/package.json mcp-server/package-lock.json ./mcp-server/
RUN npm --prefix mcp-server ci --no-audit --no-fund
COPY mcp-server ./mcp-server
RUN npm run mcp:build && npx vite build

# ── backend ─────────────────────────────────────────────────────────────────
FROM rust:1.88-bookworm AS backend
RUN apt-get update && apt-get install -y --no-install-recommends \
      protobuf-compiler pkg-config libssl-dev clang \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/src-tauri
COPY src-tauri/Cargo.toml src-tauri/Cargo.lock ./
COPY src-tauri/build.rs src-tauri/windows-app-manifest.xml ./
COPY src-tauri/src ./src
COPY src-tauri/tauri.conf.json ./
RUN cargo build --release --no-default-features --features server --bin llm-wiki-server

# ── runtime ─────────────────────────────────────────────────────────────────
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=backend /app/src-tauri/target/release/llm-wiki-server /usr/local/bin/llm-wiki-server
COPY --from=frontend /app/dist ./dist
COPY --from=frontend /app/mcp-server/dist ./mcp-server/dist
COPY src-tauri/pdfium ./pdfium

ENV LLM_WIKI_DATA_DIR=/data \
    LLM_WIKI_STATIC_DIR=/app/dist \
    LLM_WIKI_RESOURCE_DIR=/app \
    LLM_WIKI_WEB_HOST=0.0.0.0 \
    LLM_WIKI_WEB_PORT=8080
# Set LLM_WIKI_BIND_HOST=0.0.0.0 to also expose the MCP/API (:19828) and
# clip server (:19827) outside the container; they stay loopback by default.
VOLUME ["/data"]
EXPOSE 8080 19827 19828
ENTRYPOINT ["llm-wiki-server"]
