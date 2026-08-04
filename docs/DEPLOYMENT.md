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
| `packages/server/src/index-v2.js` | `node packages/server/src/index-v2.js` (or `npm run start:web`, which builds the SPA first) | SPA + v2 API + legacy bridge (single process) | `/api/v2/*` incl. `/api/v2/openapi.json`, plus `/api/invoke/*`, `/api/store/*`, `/api/events`, `/api/home` |
| `packages/server/src/index.js` | `npm run server` | SPA + legacy API | `/api/invoke/*`, `/api/store/*`, `/api/events`, `/api/raw`, `/api/proxy`, `/api/v1/*` |

The **v2 entry is the primary server**: it serves the SPA, the `/api/v2/*`
REST API, the SSE stream, and the legacy `/api/invoke/*` bridge in one
process — and it is the only entry that starts the server-driven ingest
orchestrator. The web client talks to `/api/v2/*` for auth, projects, files,
search, graph, chat writes, chat sessions, ingest, reviews, settings, and SSE
events, and to the legacy bridge for commands and store access; chat turn
start/cancel currently also goes over the bridge
(`POST /api/invoke/agent_start_turn_stream` /
`POST /api/invoke/agent_cancel_turn`). Run the legacy `index.js` entry alone
only if you deliberately want the pre-v2 surface: it has no `/api/v2/*`
routes and no ingest orchestrator, so ingest enqueued from the web client
never runs against it. See [API_REFERENCE.md](./API_REFERENCE.md) for the
endpoint inventory.

---

## Quick start (local, no Docker)

```bash
# 1. Install dependencies (root workspace)
npm install

# 2. Build the api-types schemas, then the web client into dist-web/
npm run build:api-types
npm run build:web

# 3. Start the server (serves the SPA + API on 127.0.0.1:19828)
node packages/server/src/index-v2.js
```

Open <http://127.0.0.1:19828>. `npm run start:web` runs steps 2 + 3 in one
command.

For development with hot reload, run the backend and the Vite dev server in two
terminals:

```bash
node packages/server/src/index-v2.js   # terminal 1 — backend on :19828
npm run dev:web                        # terminal 2 — SPA on :1421, proxies /api -> :19828
```

---

## Docker Compose

The repository ships a production `Dockerfile` and `docker-compose.yml` at the
repo root. The Dockerfile is a 3-stage `node:22-slim` build: the builder stage
installs the full dependency tree and runs
`npm run build:api-types && npm run build:web` (api-types must build first —
the server imports the built schemas at runtime), a deps stage produces a
production-only `node_modules` (better-sqlite3 is compiled from source against
the runtime ABI), and the runtime stage serves `dist-web/` and runs
`node packages/server/src/index-v2.js` — SPA + v2 API + legacy bridge in one
process — on port **3000** with `LLM_WIKI_HOST=0.0.0.0` and
`LLM_WIKI_DATA_DIR=/data`.

```bash
docker compose up -d --build
docker compose logs -f llm-wiki
```

The compose file wires:

| Setting | Value |
|---|---|
| `LLM_WIKI_PORT` | `3000` |
| `LLM_WIKI_AUTH_MODE` | `${LLM_WIKI_AUTH_MODE:-open}` — open by default; set `token` to require the token on all non-public routes |
| `LLM_WIKI_API_TOKEN` | `${LLM_WIKI_API_TOKEN:-}` — required on all non-public routes once set (auto mode), or always (`token` mode); empty = open local mode |
| Healthcheck | `curl -f http://localhost:3000/api/v2/health` |
| Volumes | named volume `wiki-data` → `/data` (SQLite + plugin stores) |

Project folders live on the host filesystem; add a bind mount for every folder
you want to open as a project:

```yaml
    volumes:
      - wiki-data:/data
      - /path/to/your/wikis:/wikis     # project folders (mount your real paths)
```

The in-app folder picker browses the *container's* filesystem, so it will show
the mounted paths.

Notes:

- The server binds `127.0.0.1` by default when run bare; the shipped Dockerfile
  already sets `LLM_WIKI_HOST=0.0.0.0` so the container is reachable. If you
  write your own image, set it or nothing outside the container can reach the
  server.
- `better-sqlite3` is a native module; the shipped Dockerfile compiles it in
  the image against the `node:22-slim` ABI, so build and run on the same
  architecture (automatic on amd64/arm64 with the stock image).

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
ExecStart=/usr/bin/node packages/server/src/index-v2.js
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

One unit is enough: `index-v2.js` serves the SPA, `/api/v2/*`, and the legacy
`/api/invoke/*` bridge in the same process, and it alone starts the ingest
orchestrator. (The legacy `index.js` entry is not a drop-in alternative — it
has no v2 routes and no ingest orchestrator.)

```bash
sudo mkdir -p /opt/llm-wiki/data && sudo chown llmwiki:llmwiki /opt/llm-wiki/data
sudo systemctl daemon-reload
sudo systemctl enable --now llm-wiki
sudo systemctl status llm-wiki
curl -s http://127.0.0.1:19828/api/v2/health
```

### 4. nginx reverse proxy

Create `/etc/nginx/sites-available/llm-wiki`:

```nginx
server {
    listen 80;
    server_name wiki.example.com;

    # Headroom for JSON request bodies: the server's express.json limit is
    # 64 MB. File uploads are capped separately — and lower — by
    # LLM_WIKI_MAX_UPLOAD_MB (default 50 MB; multipart and chunked alike),
    # so raising this value does not raise the upload cap.
    client_max_body_size 64m;

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

Example `fly.toml` (place at the repo root; the build uses the repo's shipped
Dockerfile):

```toml
app = "llm-wiki"
primary_region = "iad"

[build]
  # Uses the repository Dockerfile (3-stage build, runs index-v2.js).

[env]
  LLM_WIKI_HOST = "0.0.0.0"
  LLM_WIKI_PORT = "3000"
  LLM_WIKI_DATA_DIR = "/data"

[http_service]
  internal_port = 3000
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
    "startCommand": "node packages/server/src/index-v2.js",
    "healthcheckPath": "/api/v2/health",
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
   the image (via SSH, using the repo's shipped Dockerfile):

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
| `LLM_WIKI_INGEST_CONCURRENCY` | `2` | Ingest orchestrator concurrency cap (clamped 1–16). Only the v2 entry runs the orchestrator. |
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
Settings → API, or via `/api/v2/settings`). In **auto** mode, when no token is
configured the server is open (zero-friction local mode), and setting
`apiConfig.allowUnauthenticated = true` re-opens the server even when a token
exists. In **`token` mode** neither holds: with no token configured the server
is effectively closed (every non-public route answers `401`), and
`allowUnauthenticated` is ignored — the token is always required.

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
