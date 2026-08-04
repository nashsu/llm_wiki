# Deployment Guide

LLM Wiki ships as a desktop (Tauri) app and as a **web client + backend server**.
This guide covers deploying the web stack: a React SPA (`dist-web/`) served by a
zero-dependency Node.js server (`packages/server`) that also exposes the HTTP/SSE
API. The server reads and writes the same on-disk project files as the desktop
app, so both clients can share one knowledge base.

**Requirements**

- Node.js >= 20 (the server package declares `"engines": { "node": ">=20" }`)
- npm (for installing workspace dependencies and building the web client)
- A persistent volume for the data directory and your wiki project folders

**Ports**

- `19828` — default HTTP port for both server entries (SPA + API)
- `1421` — Vite dev server (`npm run dev:web` only; proxies `/api` to the backend)

**Two server entry points**

| Entry | Command | Serves | API surface |
|---|---|---|---|
| `packages/server/src/index.js` | `npm run server` | SPA + legacy API | `/api/invoke/*`, `/api/store/*`, `/api/events`, `/api/raw`, `/api/proxy`, `/api/v1/*` |
| `packages/server/src/index-v2.js` | `npm run start:v2` | API only (Express + Zod) | `/api/v2/*` incl. `/api/v2/openapi.json` |

The web client currently talks to the legacy server (`index.js`) for commands
and store access, and to `/api/v2/*` for auth, projects, files, search, graph,
chat, ingest, reviews, settings, and SSE events. For a full deployment run
**both** entries (on different ports) behind one reverse proxy, or run the
legacy server alone if you do not need the v2 REST API. See
[API_REFERENCE.md](./API_REFERENCE.md) for the endpoint inventory.

---

## Quick start (local, no Docker)

```bash
# 1. Install dependencies (root workspace)
npm install

# 2. Build the web client into dist-web/
npm run build:web

# 3. Start the server (serves the SPA + API on 127.0.0.1:19828)
npm run server
```

Open <http://127.0.0.1:19828>. `npm run start:web` runs steps 2 + 3 in one
command.

For development with hot reload, run the backend and the Vite dev server in two
terminals:

```bash
npm run server        # terminal 1 — backend on :19828
npm run dev:web       # terminal 2 — SPA on :1421, proxies /api -> :19828
```

---

## Docker Compose

There is no Dockerfile in the repository yet; the one below is the recommended
starting point. It builds the web client and runs the legacy server (which
serves the SPA). Add a second service for `index-v2.js` if you need `/api/v2/*`.

Create `Dockerfile` at the repo root:

```dockerfile
# ---- build stage ----
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig*.json ./
COPY packages ./packages
COPY mcp-server ./mcp-server
COPY src ./src
COPY index.html vite.web.config.ts vite.config.ts ./
RUN npm ci && npm run build:web

# ---- runtime stage ----
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production \
    LLM_WIKI_HOST=0.0.0.0 \
    LLM_WIKI_PORT=19828 \
    LLM_WIKI_DATA_DIR=/data
COPY --from=build /app /app
EXPOSE 19828
VOLUME ["/data"]
# Mount your wiki project folders into the container and point projects at them.
CMD ["node", "packages/server/src/index.js"]
```

Create `docker-compose.yml`:

```yaml
services:
  llm-wiki:
    build: .
    container_name: llm-wiki
    restart: unless-stopped
    ports:
      - "19828:19828"
    environment:
      LLM_WIKI_HOST: "0.0.0.0"
      LLM_WIKI_PORT: "19828"
      LLM_WIKI_DATA_DIR: "/data"
      # Set a token to require authentication (strongly recommended when exposed):
      # LLM_WIKI_API_TOKEN: "change-me"
    volumes:
      - llm-wiki-data:/data            # server state (stores, sqlite)
      - /path/to/your/wikis:/wikis     # project folders (mount your real paths)

volumes:
  llm-wiki-data:
```

```bash
docker compose up -d
docker compose logs -f llm-wiki
```

Notes:

- The server binds `127.0.0.1` by default; inside a container you **must** set
  `LLM_WIKI_HOST=0.0.0.0` or nothing outside the container can reach it.
- Project folders live on the host filesystem; bind-mount every folder you want
  to open as a project. The in-app folder picker browses the *server's*
  filesystem, so it will show the mounted paths.
- `better-sqlite3` (used by the v2 server) is a native module; if you run the
  v2 entry in Docker, build and run on the same architecture (the `node:20-slim`
  image handles this automatically on amd64/arm64).

---

## VPS deployment (Ubuntu + nginx + systemd)

Target: Ubuntu 22.04/24.04, Node 20, nginx reverse proxy with TLS via certbot.

### 1. Install Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs nginx certbot python3-certbot-nginx
node --version   # v20.x
```

### 2. Deploy the app

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin llmwiki
sudo mkdir -p /opt/llm-wiki
sudo chown llmwiki:llmwiki /opt/llm-wiki
sudo -u llmwiki git clone https://github.com/nashsu/llm_wiki.git /opt/llm-wiki/app

cd /opt/llm-wiki/app
sudo -u llmwiki npm ci
sudo -u llmwiki npm run build:web
```

### 3. systemd unit

Create `/etc/systemd/system/llm-wiki.service`:

```ini
[Unit]
Description=LLM Wiki server (web client + backend)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=llmwiki
WorkingDirectory=/opt/llm-wiki/app
ExecStart=/usr/bin/node packages/server/src/index.js
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=LLM_WIKI_HOST=127.0.0.1
Environment=LLM_WIKI_PORT=19828
Environment=LLM_WIKI_DATA_DIR=/opt/llm-wiki/data
# Require a token for all API access (recommended for internet-facing hosts):
Environment=LLM_WIKI_API_TOKEN=change-me-to-a-long-random-string

# Hardening
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=false
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

If you also need the v2 REST API, add a second unit
(`llm-wiki-v2.service`) with `ExecStart=/usr/bin/node packages/server/src/index-v2.js`
and a different port (e.g. `LLM_WIKI_PORT=19829`).

```bash
sudo mkdir -p /opt/llm-wiki/data && sudo chown llmwiki:llmwiki /opt/llm-wiki/data
sudo systemctl daemon-reload
sudo systemctl enable --now llm-wiki
sudo systemctl status llm-wiki
curl -s http://127.0.0.1:19828/api/health
```

### 4. nginx reverse proxy

Create `/etc/nginx/sites-available/llm-wiki`:

```nginx
server {
    listen 80;
    server_name wiki.example.com;

    client_max_body_size 64m;   # matches the server's 64 MB request limit

    location / {
        proxy_pass http://127.0.0.1:19828;
        proxy_http_version 1.1;

        # SSE (server-sent events) — /api/events and /api/v2/events
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 24h;
        chunked_transfer_encoding off;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/llm-wiki /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d wiki.example.com   # TLS + auto-renew
```

The SSE settings (`proxy_buffering off`, long `proxy_read_timeout`, empty
`Connection` header) are required — the server sends a `: ping` heartbeat every
25 s to keep connections alive through proxies, and buffered proxies will stall
the event stream.

### 5. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

Keep `LLM_WIKI_HOST=127.0.0.1` so the Node process is reachable only through
nginx.

---

## Fly.io

Example `fly.toml` (place at the repo root next to the Dockerfile above):

```toml
app = "llm-wiki"
primary_region = "iad"

[build]
  # Uses the Dockerfile from the Docker Compose section.

[env]
  LLM_WIKI_HOST = "0.0.0.0"
  LLM_WIKI_PORT = "19828"
  LLM_WIKI_DATA_DIR = "/data"

[http_service]
  internal_port = 19828
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0

[[mounts]]
  source = "llm_wiki_data"
  destination = "/data"

[[vm]]
  memory = "1gb"
  cpu_kind = "shared"
  cpus = 1
```

Deploy:

```bash
fly launch --no-deploy          # adopt the fly.toml, create the app
fly volumes create llm_wiki_data --size 1 --region iad
fly secrets set LLM_WIKI_API_TOKEN="$(openssl rand -hex 32)"
fly deploy
```

Caveats for Fly.io:

- **One machine, one volume.** Project state is on-disk (SQLite + JSON files);
  do not scale to multiple machines — they would diverge. Keep
  `min_machines_running` at 0 or 1.
- **Project folders.** Fly Volumes are the only persistent storage; put your
  wiki folders under `/data` (or mount a second volume) and create projects
  pointing at those paths. There is no shared desktop store in this topology —
  the server uses its own store under `LLM_WIKI_DATA_DIR`.
- **SSE.** Fly's proxy streams SSE fine; the 25 s heartbeat keeps the connection
  open.

---

## Railway

Example `railway.json` (Railway picks up the Dockerfile automatically; this
configures health checks, restarts, and the domain):

```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": {
    "builder": "DOCKERFILE",
    "dockerfilePath": "Dockerfile"
  },
  "deploy": {
    "startCommand": "node packages/server/src/index.js",
    "healthcheckPath": "/api/health",
    "healthcheckTimeout": 30,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 5
  }
}
```

Set these variables in the Railway dashboard (or `railway variables set`):

| Variable | Value |
|---|---|
| `LLM_WIKI_HOST` | `0.0.0.0` |
| `LLM_WIKI_PORT` | `19828` (Railway injects `PORT`; see note) |
| `LLM_WIKI_DATA_DIR` | `/data` |
| `LLM_WIKI_API_TOKEN` | a long random string |

Note: Railway assigns a dynamic port via the `PORT` env var. The server reads
`LLM_WIKI_PORT`, so either set `LLM_WIKI_PORT=${{PORT}}` in Railway's variable
UI or hard-code `19828` and rely on Railway's internal routing. Attach a volume
mounted at `/data` for persistence, and generate a domain under the
**Networking** tab. Same single-instance caveat as Fly.io: do not run more than
one replica.

---

## Home server (Docker on Synology / Unraid)

### Synology DSM (Container Manager)

1. Copy the repo to a shared folder, e.g. `/volume1/docker/llm-wiki`, and build
   the image (via SSH, using the Dockerfile from the Docker Compose section):

   ```bash
   sudo docker build -t llm-wiki:local /volume1/docker/llm-wiki
   ```

2. In **Container Manager → Project → Create**, paste the `docker-compose.yml`
   from the [Docker Compose](#docker-compose) section. Adjust the volume paths:

   ```yaml
   volumes:
     - /volume1/docker/llm-wiki/data:/data
     - /volume1/wiki-projects:/wikis
   ```

3. Create the host folders first (`data/`, and your wiki project folders under
   `wiki-projects/`) and set `LLM_WIKI_API_TOKEN` in the compose `environment`.
4. Start the project. Access the UI at `http://<synology-ip>:19828`.

If you run Synology's built-in reverse proxy (Control Panel → Login Portal →
Advanced → Reverse Proxy), forward HTTPS to `localhost:19828` and enable
**WebSocket/HTTP 2** support so SSE streams are not buffered.

### Unraid

1. Build or import the image as above (Unraid terminal:
   `docker build -t llm-wiki:local /mnt/user/appdata/llm-wiki-src`).
2. In the Docker tab, **Add Container**:
   - **Repository:** `llm-wiki:local`
   - **Network type:** `bridge`
   - **Add Path** (host `/mnt/user/appdata/llm-wiki/data` → container `/data`)
   - **Add Path** (host `/mnt/user/wiki-projects` → container `/wikis`)
   - **Add Port** (host `19828` → container `19828`)
   - **Add Variable** `LLM_WIKI_HOST` = `0.0.0.0`
   - **Add Variable** `LLM_WIKI_DATA_DIR` = `/data`
   - **Add Variable** `LLM_WIKI_API_TOKEN` = your token
3. Apply. The UI is at `http://<unraid-ip>:19828`.

Home-server tips:

- Put your wiki folders on the array/pool and bind-mount them; the server's
  folder picker browses the container's filesystem, so it will show `/wikis`.
- If you access the UI only on your LAN you can leave `LLM_WIKI_API_TOKEN`
  unset (open local mode), but setting a token costs nothing and protects
  against a device on the LAN being compromised.
- For remote access, prefer a VPN (WireGuard/Tailscale) over exposing the port
  to the internet.

---

## Environment variables reference

### Server (both entries)

| Variable | Default | Description |
|---|---|---|
| `LLM_WIKI_PORT` | `19828` | HTTP port for the server (SPA + API). |
| `LLM_WIKI_HOST` | `127.0.0.1` | Bind address. Set `0.0.0.0` to expose on the LAN / inside a container. Keep loopback when behind a reverse proxy. |
| `LLM_WIKI_DATA_DIR` | `~/.llm-wiki-server` | Server-side persistent state (plugin-store JSON, SQLite DB for v2). Point at a volume in containers. |
| `LLM_WIKI_MAX_UPLOAD_MB` | `50` | Maximum size in MB for a single file upload (multipart and chunked uploads alike; clamped to 1–4096). |
| `LLM_WIKI_WEB_DIST` | `<repo>/dist-web` | Path to the built web client. Only needed if you serve the SPA from a non-default location. |
| `LLM_WIKI_AUTH_MODE` | unset (auto) | Auth mode (chartered name, §4.5): `none` = always open; `token` = token required on all non-public routes; unset = **auto** (open when no token is configured, required when one is set). `open` is accepted as a synonym of `none` (the docker-compose default). The legacy `AUTH_MODE` variable still works as a deprecated alias; `LLM_WIKI_AUTH_MODE` wins when both are set. |
| `LLM_WIKI_API_TOKEN` | unset | API token. Required on all non-public endpoints in `token` mode, or in `auto` mode once set (Bearer header, `x-llm-wiki-token` header, or `?token=` query). See [CLIENT_CONFIG.md](./CLIENT_CONFIG.md). |
| `LLM_WIKI_STORE_FILE` | unset | Absolute path to a plugin-store file (`app-state.json`) to use instead of auto-detecting the desktop app's store. |
| `LLM_WIKI_NO_SHARE` | unset | `1` = never share the desktop app's store; use a web-only store under `LLM_WIKI_DATA_DIR`. |
| `LLM_WIKI_ALLOW_SHELL` | unset | `1` = allow the chat agent's shell tools. Leave unset unless you trust every API client. |

### Build / dev only

| Variable | Default | Description |
|---|---|---|
| `LLM_WIKI_BACKEND` | `http://127.0.0.1:19828` | Backend the Vite dev server proxies `/api` to (`npm run dev:web` only). |
| `VITE_API_URL` | `""` (same origin) | Baked into the web client at build time; the API base URL for remote deployments. See [CLIENT_CONFIG.md](./CLIENT_CONFIG.md). |

### Auth precedence

**Mode:** `LLM_WIKI_AUTH_MODE` is the primary variable (`none|token`; `open`
is a synonym of `none`). The legacy `AUTH_MODE` remains a deprecated alias —
it still works when the primary is unset and logs a one-time deprecation
warning; when both are set, `LLM_WIKI_AUTH_MODE` wins. With neither set the
server runs in **auto** mode: open while no token is configured, required as
soon as one exists.

**Token:** the effective token is `LLM_WIKI_API_TOKEN` (env) if set, otherwise the token
stored in the shared store's `apiConfig.token` (set via the desktop app's
Settings → API, or via `/api/v2/settings`). When no token is configured the
server is open (zero-friction local mode). Setting `apiConfig.allowUnauthenticated = true`
re-opens the server even when a token exists.

---

## Health checks & verification

```bash
# Legacy server
curl -s http://127.0.0.1:19828/api/health
# {"ok":true,"name":"llm-wiki-server","commands":N,"sseClients":N,...}

# v2 server
curl -s http://127.0.0.1:19828/api/v2/health
# {"ok":true,"version":"0.6.6","commands":N}

# Auth posture (public)
curl -s http://127.0.0.1:19828/api/v2/auth/status
# {"authRequired":true,"authConfigured":true,"allowUnauthenticated":false}
```

## Upgrading

```bash
cd /opt/llm-wiki/app
sudo -u llmwiki git pull
sudo -u llmwiki npm ci
sudo -u llmwiki npm run build:web
sudo systemctl restart llm-wiki
```

The v2 server runs SQLite migrations automatically on first boot of a new
version. Back up `LLM_WIKI_DATA_DIR` and your project folders before upgrading.
