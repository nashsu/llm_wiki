# Connectors

> **中文摘要**：Connector 只負責「遠端長什麼樣」（`list_all`）和「拿一份下來」（`fetch`），不碰 wiki、ingest 或 UI。註冊表（`descriptors()` / `build()`）就是工廠：每種 connector 宣告自己的設定欄位與認證方式，設定頁據此自動產生表單。共用的 SyncEngine 負責 diff、寫入 `raw/sources/@<名稱>/`、刪除與狀態檔；之後交給既有的 Source Watch 走 ingest。目前有 `local-folder` 與 `google-drive`（OAuth PKCE、自帶 client、支援 delta）。

Connectors pull documents from external systems into a project's
`raw/sources/` folder. From there the existing pipeline takes over: the
source-folder watcher (or the startup rescan when the project is opened
next) queues new/changed files for ingest and runs the cascade cleanup for
removed ones. Nothing downstream knows a connector exists.

```
                     ┌──────────────── connectors (Rust) ────────────────┐
 remote system ─────►│ Connector::list_all(cursor) ─► Listing            │
                     │ Connector::fetch(item)      ─► bytes + file name  │
                     │            ▼                                      │
                     │ sync::run_sync — diff vs .llm-wiki/connectors/<id>.state.json
                     │   add/update → raw/sources/@<name>/<remote path>  │
                     │   delete     → remove file (+ prune empty dirs)   │
                     └───────────────────────┬───────────────────────────┘
                                             ▼
                      source-folder watcher / startup rescan → ingest queue
```

## Layers

| Layer | Where | Responsibility |
|-------|-------|----------------|
| `Connector` trait | `src-tauri/src/connectors/mod.rs` | `test()`, `list_all(cursor) -> Listing`, `fetch(item) -> Fetched`. No project paths, no wiki. |
| Registry / factory | `mod.rs` — `descriptors()`, `build(ctx, instance, secrets)` | One `ConnectorDescriptor` per kind (label, config fields, auth kind, delta support) and one `match` arm that instantiates it. |
| Sync engine | `sync.rs` | Version diff, path sanitising, size/extension filters, atomic writes, deletions, per-instance state, progress events (`connectors://sync`). |
| Storage | `store.rs` | `<project>/.llm-wiki/connectors.json` (instances), `<project>/.llm-wiki/connectors/<id>.state.json` (cursor + item versions), `<app data>/connectors-secrets.json` (tokens/secrets, 0600 on Unix, never inside the project). |
| OAuth | `oauth.rs` | Authorization-code + PKCE, pending-state table, token exchange/refresh, callback HTML. |
| Scheduler | `scheduler.rs` | Every minute, run every enabled instance whose `interval_minutes` has elapsed — across all known projects, in the backend, so it works headless. |
| Commands | `commands.rs` | `connector_descriptors/list/save/delete/test/sync/reset/oauth_start/oauth_disconnect` — registered for Tauri IPC (`lib.rs`) and the web RPC bridge (`web/rpc.rs`). |
| UI | `src/components/settings/sections/connectors-section.tsx` | Generic form from descriptors; cards with status, Sync now, Test, Connect/Disconnect. `src/commands/connectors.ts` holds the typed wrappers. |

### Listing semantics

`Listing { items, is_delta, next_cursor }`:

* `is_delta = false` — a full snapshot. Anything the engine had that is not
  in the snapshot is treated as deleted. Connectors without change feeds
  (local folder, WebDAV, S3…) always do this.
* `is_delta = true` — only what changed since the cursor the engine passed
  in; removals come back with `deleted = true`. `next_cursor` is stored and
  passed to the next run. Google Drive uses `changes.list`.

Equal `version` strings (checksum, etag, `mtime-size`…) mean "unchanged":
no download. Items land at `raw/sources/@<instance name>/<path…>` with
every component sanitised (no separators, no `..`, no control characters).
Directories in the remote path become the `folderContext` hint the ingest
step already uses for classification.

## Kinds

### `local-folder`

Mirror a directory on the machine running the backend. Full walk every run,
hidden entries skipped, `version = mtime-size`. Useful on its own (a Syncthing
/ Dropbox / OneDrive-client folder) and as the reference implementation.

### `google-drive`

Drive API v3 with the `drive.readonly` scope.

* **Auth — bring your own OAuth client.** Create an OAuth client in Google
  Cloud Console (APIs & Services → Credentials), enable the Drive API, and
  paste client id / secret into the connector. Register the redirect URI the
  form shows: `http://127.0.0.1:19828/api/v1/oauth/callback` for the desktop
  app ("Desktop app" client type) or `https://<host>/web/connectors/oauth/callback`
  for the web server ("Web application" type). Press **Connect**; tokens are
  stored in `connectors-secrets.json` and refreshed automatically.
* **Scope:** a folder id (or full folder URL) or blank for all of My Drive.
  Shared drives are included through `supportsAllDrives`.
* **Delta:** the first run walks the tree (`files.list`) after taking a
  `changes.getStartPageToken`; later runs use `changes.list` and only touch
  changed files. An expired cursor (Drive keeps them about a week) triggers
  a full resync automatically.
* **Google-native files:** Docs / Sheets / Slides are exported as
  `.docx` / `.xlsx` / `.pptx` (Drive caps exports at 10 MB); other native
  types (Forms, Drawings…) are skipped.

## Adding a connector

1. Create `src-tauri/src/connectors/<kind>.rs` implementing `Connector`
   and a `descriptor()` listing its config fields (`text`, `number`,
   `boolean`, `secret`, `path`). Secret fields are stored in the secrets
   file and never echoed back to the UI.
2. Add it to `descriptors()` and `build()` in `mod.rs`.
3. If it needs OAuth, add a `ProviderDef` in `oauth.rs` (auth/token URLs)
   and set `AuthKind::OAuth2 { provider, scopes }` in the descriptor. The
   connector reads a valid token with `oauth::access_token(ctx, id, provider)`.
4. Prefer a delta feed when the API offers one (`is_delta = true` +
   `next_cursor`); otherwise return snapshots and let the engine diff.
5. Tests: unit-test the mapping helpers; the engine's own tests use a fake
   connector, so no network is needed.

Natural next kinds: OneDrive / SharePoint (Graph `delta`), Dropbox
(`list_folder/continue` cursors), Notion (`last_edited_time` filter),
WebDAV / Nextcloud (snapshot), S3 (snapshot with ETag versions).

## Operational notes

* Syncs run in the backend; the scheduler ticks every minute and skips
  instances that are already running. "Sync now" returns immediately and
  reports through `connectors://sync` events (`started → listed →
  progress… → finished | failed`).
* Deleting an instance can also purge its mirrored files; either way the
  removal of `raw/sources/@<name>/…` files flows through the same
  external-delete cleanup as any other source removal.
* Renaming an instance moves its folder: the engine purges the old mirror
  and resyncs into the new name.
* The legacy **Scheduled Import** section is untouched; a `local-folder`
  connector covers the same use case with a persistent state file and
  backend scheduling, so it can replace it once you are happy with it.
