# Client Configuration

How the LLM Wiki web client finds its server, and how authentication works in
each deployment topology.

The web client is a React SPA built with Vite (`npm run build:web` →
`dist-web/`). All API access goes through one fetch wrapper
(`src/api/client.ts`) that resolves every request against a **base URL** and
attaches an **auth token** from `localStorage`.

---

## VITE_API_URL

`VITE_API_URL` is a **build-time** environment variable (Vite inlines
`import.meta.env.VITE_API_URL` into the bundle). It sets the base URL for every
API call.

```ts
// src/api/client.ts
export function getBaseUrl(): string {
  return import.meta.env.VITE_API_URL ?? ""
}
```

| Value | Meaning |
|---|---|
| unset / `""` | **Same-origin mode.** Requests resolve against the page's own host (e.g. `/api/v2/...` on `https://wiki.example.com`). This is the default and the recommended setup — the server serves both the SPA and the API, so there is no CORS friction. |
| `https://api.example.com` | **Remote mode.** Requests go to that origin (e.g. `https://api.example.com/api/v2/...`). Use when the SPA is hosted separately from the server (static hosting, CDN, a different domain). |

### Building for a remote backend

```bash
VITE_API_URL=https://api.example.com npm run build:web
```

Because the value is baked in at build time, changing the backend URL requires
a rebuild — you cannot reconfigure a deployed bundle at runtime. Serve the
SPA and API from the same origin whenever possible to avoid this entirely.

### CORS

The server sends `Access-Control-Allow-Origin: *` and answers preflight
`OPTIONS` requests (allowing `Content-Type`, `Authorization`, and
`x-llm-wiki-token` headers), so remote mode works out of the box. If you put a
reverse proxy in front, make sure it does not strip or override these headers.

---

## Authentication model

The server uses **token-based auth** with no username/password (decision #14,
mirroring the desktop app's external-API contract). There is exactly one shared
API token; any client that presents it is authorized.

### Where the token comes from (server side)

Resolved in this order by `packages/server/src/auth/config.js`:

1. `LLM_WIKI_API_TOKEN` environment variable, or
2. `apiConfig.token` in the shared plugin-store (set in the desktop app under
   Settings → API, or via `PUT /api/v2/settings/apiConfig`).

Auth posture (default **auto** mode — `LLM_WIKI_AUTH_MODE` unset; see
[DEPLOYMENT.md](./DEPLOYMENT.md) for the `none`/`token` modes):

- **No token configured** → the server is **open**; every request passes
  (zero-friction local mode).
- **Token configured** → every non-public endpoint requires the token, unless
  `apiConfig.allowUnauthenticated` is `true` (explicitly re-opened).
- Under `LLM_WIKI_AUTH_MODE=token` the token is required regardless — with no
  token configured the server is closed, and `allowUnauthenticated` is
  ignored; under `LLM_WIKI_AUTH_MODE=none` (or `open`) it is always open.

Public endpoints that never require a token: `/api/v2/health`,
`/api/v2/version`, `/api/v2/auth/status`, `/api/v2/auth/login`.

### How the client sends the token

Three equivalent forms are accepted by the server (constant-time compared):

| Form | Example |
|---|---|
| `Authorization` header (used by the web client) | `Authorization: Bearer <token>` |
| Custom header | `x-llm-wiki-token: <token>` |
| Query parameter | `GET /api/v2/projects?token=<token>` |

The web client stores the token in `localStorage` under the key
`llm-wiki-token` and attaches it as a `Bearer` header on every request
automatically:

```ts
// src/api/client.ts
export const TOKEN_STORAGE_KEY = "llm-wiki-token"

const token = getToken()                       // localStorage
if (token) headers.set("Authorization", `Bearer ${token}`)
```

---

## Login flow

In the web build, `src/main.tsx` mounts the login screen
(`src/components/LoginScreen.tsx`) unconditionally in front of the app; the
flow is driven by that component and `src/api/auth.ts`
(`getAuthStatus` / `login`):

1. **On load**, the client calls `GET /api/v2/auth/status` (public):

   ```json
   { "authRequired": true, "authConfigured": true, "allowUnauthenticated": false }
   ```

2. **If `authRequired` is `false`** (the server is open) the login screen
   skips itself and enters the app immediately. The skip depends ONLY on the
   server's answer — a token already stored in `localStorage` never causes a
   skip (nothing auto-submits it), and `authRequired` is purely server-side:
   it never reflects any individual client's stored token.

3. **If `authRequired` is `true`**, the token form is shown. The user pastes
   the server token (the one from the desktop app's Settings → API, or
   `LLM_WIKI_API_TOKEN`).

4. **On submit**, the client calls `POST /api/v2/auth/login`:

   ```json
   { "token": "<token>" }
   ```

   - Success → `{ "success": true, "message": "Authenticated" }`. The client
     persists the token to `localStorage` (`llm-wiki-token`) and enters the
     app; all subsequent requests carry it as a Bearer header.
   - Failure → `401` with `{ "error": { "code": "UNAUTHORIZED", "message": "Invalid token" } }`;
     the error is shown inline and the form stays.

5. **Logout** is client-side only: it removes the token from `localStorage`
   (`logout()` in `src/api/auth.ts`). There is no server session to revoke —
   rotate the token itself (env var or `apiConfig.token`) to invalidate all
   clients.

There is no separate connection-state module — the gate is exactly the check
above: `!status.authRequired` skips the form, otherwise the form shows. The
stored token's only job is request auth: `getToken()` (in `src/api/client.ts`)
attaches it as a Bearer header on outgoing API/SSE requests; startup code
never reads it to decide whether to show the login screen.

---

## Local mode (same origin, no auth)

The default single-host deployment: the server serves the SPA and the API from
the same origin, and no token is configured.

```
Browser ── same origin ──► llm-wiki-server (:19828)
                           serves dist-web/ + /api/*
```

- Build with `VITE_API_URL` unset (the default).
- Leave `LLM_WIKI_API_TOKEN` unset.
- `GET /api/v2/auth/status` returns `authRequired: false`, so the login screen
  auto-skips and the app loads directly.
- `POST /api/v2/auth/login` succeeds with any token and returns
  `{ "success": true, "message": "Authenticated (open mode)" }`.

This is the zero-friction path for `npm run start:web` on your own machine.
Because the server binds `127.0.0.1` by default, open mode is safe locally —
do **not** combine open mode with `LLM_WIKI_HOST=0.0.0.0` on an untrusted
network.

---

## Remote mode (different origin, token required)

For any deployment the client reaches over a network — a VPS, Fly.io, Railway,
a home server accessed via VPN — configure a token and point the client at the
server's origin.

```
Browser (app.example.com) ── HTTPS + Bearer token ──► api.example.com (:19828)
```

1. **Server:** set `LLM_WIKI_API_TOKEN` (see [DEPLOYMENT.md](./DEPLOYMENT.md)).
   Once a token is set, `authRequired` becomes `true` and every non-public
   endpoint rejects unauthenticated requests with `401 UNAUTHORIZED`.
2. **Client:** build with the server's origin:

   ```bash
   VITE_API_URL=https://api.example.com npm run build:web
   ```

   Or, if the reverse proxy serves the SPA and API under one domain, leave
   `VITE_API_URL` unset (same-origin) — this is preferred and avoids CORS
   entirely.
3. **First visit:** the login screen appears (status reports
   `authRequired: true`). Enter the token; it is validated against
   `/api/v2/auth/login` and stored for all future requests.

### Checklist for remote deployments

- [ ] `LLM_WIKI_API_TOKEN` set to a long random value (`openssl rand -hex 32`).
- [ ] TLS in front of the server (certbot/nginx, Fly/Railway force HTTPS) —
      the token travels on every request and must not go over plain HTTP.
- [ ] `VITE_API_URL` matches the public origin, or SPA+API share one origin.
- [ ] Reverse proxy passes SSE (`proxy_buffering off`) so `/api/v2/events`
      streams work — see [DEPLOYMENT.md](./DEPLOYMENT.md).
- [ ] If hosting the SPA on a separate static host, confirm the server's CORS
      headers reach the browser (some CDNs strip `Access-Control-Allow-Origin`).

### Switching servers / clearing credentials

The client remembers only the token (in `localStorage['llm-wiki-token']`). To
point an existing browser at a different server or re-authenticate, clear that
key (or use the app's logout, which removes it) and reload — the login screen
returns if the new server requires auth.
