//! Web server mode.
//!
//! Serves the built React frontend (`dist/`) and bridges everything the
//! frontend needs from the host over HTTP, so the same UI runs in a browser
//! against a headless backend:
//!
//! | Route                     | Purpose                                                    |
//! |---------------------------|------------------------------------------------------------|
//! | `POST /web/rpc/{command}` | `invoke()` replacement → [`rpc::dispatch`]                 |
//! | `GET  /web/events`        | `listen()` replacement — SSE stream of [`AppCtx::emit`]    |
//! | `GET  /web/file?path=`    | `convertFileSrc()` replacement (images, media, downloads)  |
//! | `POST /web/upload`        | file-picker replacement — multipart upload to a temp dir   |
//! | `POST /web/proxy`         | `tauri-plugin-http` replacement — outbound LLM/API calls   |
//! | `POST /web/auth/login`    | password → session cookie                                  |
//! | `GET  /web/auth/me`       | auth status, runtime mode, version                         |
//! | `GET  /web/health`        | liveness                                                   |
//! | `/*`                      | static frontend (SPA fallback to `index.html`)             |
//!
//! Security model (single-user / small-team self-hosting): one shared
//! password (`--password`, `LLM_WIKI_WEB_PASSWORD`, or the desktop setting)
//! gates every `/web/*` route except login/health. Sessions are random
//! tokens in an `HttpOnly` cookie. Requests from scripts may instead send
//! `Authorization: Bearer <password>`. When no password is configured and
//! the server binds a loopback address, access is open (like the desktop
//! app); on any other bind address a random password is generated and
//! printed at startup so the server is never silently exposed.

pub mod rpc;
pub mod store;

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Multipart, Path as AxumPath, Query, Request, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use axum::Router;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_stream::wrappers::BroadcastStream;
use tower::ServiceExt;
use tower_http::services::{ServeDir, ServeFile};

use crate::app_ctx::AppCtx;

const SESSION_COOKIE: &str = "llm_wiki_session";
const MAX_UPLOAD_BYTES: usize = 4 * 1024 * 1024 * 1024; // 4 GiB
const MAX_RPC_BODY_BYTES: usize = 256 * 1024 * 1024;
const PROXY_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

// ── configuration ───────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct WebServerOptions {
    pub host: String,
    pub port: u16,
    pub password: Option<String>,
    pub static_dir: Option<PathBuf>,
}

impl WebServerOptions {
    /// Options for the headless binary, from CLI flags and environment.
    pub fn from_env_and_args(args: &[String]) -> Result<Self, String> {
        let mut host = std::env::var("LLM_WIKI_WEB_HOST").unwrap_or_else(|_| "127.0.0.1".into());
        let mut port = std::env::var("LLM_WIKI_WEB_PORT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(8080u16);
        let mut password = std::env::var("LLM_WIKI_WEB_PASSWORD")
            .ok()
            .filter(|p| !p.trim().is_empty());
        let mut static_dir = std::env::var("LLM_WIKI_STATIC_DIR").ok().map(PathBuf::from);

        let mut iter = args.iter().skip(1);
        while let Some(arg) = iter.next() {
            let mut take = |name: &str| -> Result<String, String> {
                iter.next()
                    .cloned()
                    .ok_or_else(|| format!("{name} requires a value"))
            };
            match arg.as_str() {
                "--host" => host = take("--host")?,
                "--port" => {
                    port = take("--port")?
                        .parse()
                        .map_err(|_| "--port must be a number".to_string())?
                }
                "--password" => password = Some(take("--password")?),
                "--static-dir" => static_dir = Some(PathBuf::from(take("--static-dir")?)),
                "--data-dir" => std::env::set_var("LLM_WIKI_DATA_DIR", take("--data-dir")?),
                "--resource-dir" => {
                    std::env::set_var("LLM_WIKI_RESOURCE_DIR", take("--resource-dir")?)
                }
                "--help" | "-h" => {
                    println!("{}", HELP);
                    std::process::exit(0);
                }
                other => return Err(format!("Unknown argument: {other}\n{HELP}")),
            }
        }
        Ok(Self {
            host,
            port,
            password,
            static_dir,
        })
    }
}

const HELP: &str = "llm-wiki-server — LLM Wiki web server

USAGE:
    llm-wiki-server [--host 127.0.0.1] [--port 8080] [--password ...]
                    [--data-dir DIR] [--static-dir DIR] [--resource-dir DIR]

ENVIRONMENT:
    LLM_WIKI_WEB_HOST, LLM_WIKI_WEB_PORT, LLM_WIKI_WEB_PASSWORD,
    LLM_WIKI_DATA_DIR (default ~/.llm-wiki), LLM_WIKI_STATIC_DIR (built frontend),
    LLM_WIKI_RESOURCE_DIR (folder containing pdfium/ and mcp-server/dist),
    LLM_WIKI_BIND_HOST (bind host for the local API on :19828 and clip server on :19827)";

/// Locate the built frontend for the static file service.
pub fn resolve_static_dir(explicit: Option<PathBuf>, ctx: &AppCtx) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = explicit {
        candidates.push(dir);
    }
    if let Some(res) = ctx.resource_dir() {
        candidates.push(res.join("dist"));
        candidates.push(res.join("..").join("dist"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("dist"));
            candidates.push(dir.join("..").join("dist"));
            candidates.push(dir.join("..").join("..").join("dist"));
            candidates.push(dir.join("..").join("..").join("..").join("dist"));
        }
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("dist"));
    candidates
        .into_iter()
        .find(|dir| dir.join("index.html").is_file())
        .and_then(|dir| dir.canonicalize().ok())
}

// ── state ───────────────────────────────────────────────────────────────────

pub struct WebAuth {
    password: Option<String>,
    sessions: Mutex<HashSet<String>>,
}

impl WebAuth {
    fn required(&self) -> bool {
        self.password.is_some()
    }

    fn check_password(&self, candidate: &str) -> bool {
        match &self.password {
            Some(expected) => constant_time_eq(expected.as_bytes(), candidate.as_bytes()),
            None => true,
        }
    }

    fn open_session(&self) -> String {
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        self.sessions
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(token.clone());
        token
    }

    fn close_session(&self, token: &str) {
        self.sessions
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(token);
    }

    fn has_session(&self, token: &str) -> bool {
        self.sessions
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .contains(token)
    }
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in left.iter().zip(right.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

#[derive(Clone)]
pub struct WebState {
    ctx: AppCtx,
    auth: Arc<WebAuth>,
    static_dir: Option<PathBuf>,
}

// ── entry points ────────────────────────────────────────────────────────────

/// Entry point of the `llm-wiki-server` binary.
#[cfg(feature = "server")]
pub fn main() {
    let args: Vec<String> = std::env::args().collect();
    let options = match WebServerOptions::from_env_and_args(&args) {
        Ok(options) => options,
        Err(err) => {
            eprintln!("{err}");
            std::process::exit(2);
        }
    };

    #[cfg(not(feature = "desktop"))]
    {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_name("llm-wiki-rt")
            .build()
            .expect("failed to build tokio runtime");
        crate::rt::install_runtime(runtime);
    }

    let data_dir = crate::app_ctx::default_data_dir();
    if let Err(err) = std::fs::create_dir_all(&data_dir) {
        eprintln!("[web] cannot create data dir {}: {err}", data_dir.display());
        std::process::exit(1);
    }
    let resource_dir = resolve_resource_dir();
    let ctx = AppCtx::headless(data_dir.clone(), resource_dir.clone());
    crate::register_shared_state(&ctx);
    if let Some(dir) = resource_dir {
        crate::commands::fs::set_resource_dir_hint(dir);
    }
    if let Some(cfg) = crate::proxy::read_proxy_config_from_store(&ctx.app_state_path()) {
        let summary = crate::proxy::apply_proxy_env(&cfg);
        eprintln!("[proxy] {summary}");
    }

    // The MCP-facing local API (:19828) and the browser-extension clip
    // server (:19827) work the same way as in the desktop app.
    crate::clip_server::start_clip_server(ctx.clone());
    crate::api_server::start_api_server(ctx.clone());
    crate::connectors::scheduler::start(ctx.clone());

    eprintln!("[web] data dir: {}", data_dir.display());
    if let Err(err) = crate::rt::block_on(serve(ctx, options)) {
        eprintln!("[web] {err}");
        std::process::exit(1);
    }
}

#[cfg(feature = "server")]
/// Resource directory for the headless server: `$LLM_WIKI_RESOURCE_DIR`,
/// else the first ancestor of the executable that contains `pdfium/`,
/// else the crate directory (development).
fn resolve_resource_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("LLM_WIKI_RESOURCE_DIR") {
        return Some(PathBuf::from(dir));
    }
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe.parent().map(Path::to_path_buf);
        for _ in 0..4 {
            let Some(current) = dir else { break };
            if current.join("pdfium").is_dir() {
                return Some(current);
            }
            dir = current.parent().map(Path::to_path_buf);
        }
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if manifest.join("pdfium").is_dir() {
        return Some(manifest);
    }
    None
}

/// Desktop app: start the web server in-process when enabled in settings
/// (`webServerConfig` in `app-state.json`). Lets a running desktop app be
/// used from a browser on another device.
pub fn maybe_start_embedded(ctx: AppCtx) {
    let raw = store::get(&ctx.app_state_path(), "webServerConfig");
    let enabled = raw
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !enabled {
        return;
    }
    let options = WebServerOptions {
        host: raw
            .get("host")
            .and_then(Value::as_str)
            .map(str::to_string)
            .filter(|h| !h.trim().is_empty())
            .unwrap_or_else(|| "127.0.0.1".into()),
        port: raw
            .get("port")
            .and_then(Value::as_u64)
            .map(|p| p as u16)
            .unwrap_or(8080),
        password: raw
            .get("password")
            .and_then(Value::as_str)
            .map(str::to_string)
            .filter(|p| !p.trim().is_empty()),
        static_dir: None,
    };
    crate::rt::spawn(async move {
        if let Err(err) = serve(ctx, options).await {
            eprintln!("[web] embedded server failed: {err}");
        }
    });
}

/// Bind and serve until the process exits.
pub async fn serve(ctx: AppCtx, options: WebServerOptions) -> Result<(), String> {
    let bind_is_loopback = options
        .host
        .parse::<std::net::IpAddr>()
        .map(|ip| ip.is_loopback())
        .unwrap_or(options.host == "localhost");
    let password = match options.password.clone() {
        Some(p) => Some(p),
        None if bind_is_loopback => {
            eprintln!("[web] no password configured; loopback bind → open access");
            None
        }
        None => {
            let generated = uuid::Uuid::new_v4().simple().to_string();
            eprintln!(
                "[web] no password configured and binding to a non-loopback address.\n[web] Generated password: {generated}\n[web] Set LLM_WIKI_WEB_PASSWORD or --password to choose your own."
            );
            Some(generated)
        }
    };
    let static_dir = resolve_static_dir(options.static_dir.clone(), &ctx);
    match &static_dir {
        Some(dir) => eprintln!("[web] serving frontend from {}", dir.display()),
        None => eprintln!(
            "[web] built frontend not found (run `npm run build` or pass --static-dir); serving API only"
        ),
    }

    let state = WebState {
        ctx,
        auth: Arc::new(WebAuth {
            password,
            sessions: Mutex::new(HashSet::new()),
        }),
        static_dir: static_dir.clone(),
    };

    let api = Router::new()
        .route("/web/health", get(health))
        .route("/web/auth/login", post(login))
        .route("/web/auth/logout", post(logout))
        .route("/web/auth/me", get(me))
        .route("/web/rpc/{command}", post(rpc_call))
        .route("/web/events", get(events))
        .route("/web/file", get(file))
        .route("/web/upload", post(upload))
        .route("/web/proxy", post(proxy))
        .route("/web/connectors/oauth/callback", get(oauth_callback))
        .layer(middleware::from_fn_with_state(state.clone(), require_auth))
        .layer(DefaultBodyLimit::max(MAX_UPLOAD_BYTES))
        .with_state(state);

    let app = match static_dir {
        Some(dir) => {
            let index = dir.join("index.html");
            api.fallback_service(ServeDir::new(dir).not_found_service(ServeFile::new(index)))
        }
        None => api.fallback(no_frontend),
    };

    let addr = crate::server_bind::bind_addr(&options.host, options.port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("failed to bind {addr}: {e}"))?;
    let local: SocketAddr = listener
        .local_addr()
        .map_err(|e| format!("failed to read bound address: {e}"))?;
    eprintln!("[web] listening on http://{local}/");
    axum::serve(listener, app)
        .await
        .map_err(|e| format!("server error: {e}"))
}

// ── auth ────────────────────────────────────────────────────────────────────

fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|line| line.split(';'))
        .filter_map(|pair| {
            let (k, v) = pair.trim().split_once('=')?;
            (k.trim() == name).then(|| v.trim().to_string())
        })
        .next()
}

fn is_authenticated(state: &WebState, headers: &HeaderMap) -> bool {
    if !state.auth.required() {
        return true;
    }
    if let Some(token) = cookie_value(headers, SESSION_COOKIE) {
        if state.auth.has_session(&token) {
            return true;
        }
    }
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|token| state.auth.check_password(token.trim()))
        .unwrap_or(false)
}

async fn require_auth(State(state): State<WebState>, req: Request, next: Next) -> Response {
    let path = req.uri().path();
    // The OAuth redirect comes from the provider; it is validated by the
    // one-time `state` token instead of the session cookie.
    let exempt = matches!(
        path,
        "/web/health"
            | "/web/auth/login"
            | "/web/auth/me"
            | "/web/auth/logout"
            | "/web/connectors/oauth/callback"
    );
    if exempt || is_authenticated(&state, req.headers()) {
        return next.run(req).await;
    }
    error_response(StatusCode::UNAUTHORIZED, "Authentication required")
}

#[derive(Deserialize)]
struct LoginBody {
    password: String,
}

async fn login(State(state): State<WebState>, Json(body): Json<LoginBody>) -> Response {
    if !state.auth.check_password(&body.password) {
        // Small fixed delay blunts online guessing without a full limiter.
        tokio::time::sleep(Duration::from_millis(400)).await;
        return error_response(StatusCode::UNAUTHORIZED, "Invalid password");
    }
    let token = state.auth.open_session();
    let cookie = format!("{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax");
    let mut response = Json(json!({ "ok": true })).into_response();
    if let Ok(value) = HeaderValue::from_str(&cookie) {
        response.headers_mut().insert(header::SET_COOKIE, value);
    }
    response
}

async fn logout(State(state): State<WebState>, headers: HeaderMap) -> Response {
    if let Some(token) = cookie_value(&headers, SESSION_COOKIE) {
        state.auth.close_session(&token);
    }
    let cookie = format!("{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    let mut response = Json(json!({ "ok": true })).into_response();
    if let Ok(value) = HeaderValue::from_str(&cookie) {
        response.headers_mut().insert(header::SET_COOKIE, value);
    }
    response
}

async fn me(State(state): State<WebState>, headers: HeaderMap) -> Json<Value> {
    Json(json!({
        "ok": true,
        "authenticated": is_authenticated(&state, &headers),
        "authRequired": state.auth.required(),
        "mode": if state.ctx.is_desktop() { "desktop" } else { "server" },
        "version": env!("CARGO_PKG_VERSION"),
        "frontend": state.static_dir.is_some(),
    }))
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") }))
}

async fn no_frontend() -> Response {
    (
        StatusCode::NOT_FOUND,
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        "LLM Wiki server is running, but the built frontend was not found.\nRun `npm run build` in the repository or start the server with --static-dir <path-to-dist>.\n",
    )
        .into_response()
}

fn error_response(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "ok": false, "error": message }))).into_response()
}

// ── connectors: OAuth redirect target ───────────────────────────────────────

async fn oauth_callback(State(state): State<WebState>, req: Request) -> Response {
    let query = req.uri().query().unwrap_or("").to_string();
    let (ok, html) = crate::connectors::oauth::handle_callback(&state.ctx, &query).await;
    (
        if ok { StatusCode::OK } else { StatusCode::BAD_REQUEST },
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        html,
    )
        .into_response()
}

// ── rpc ─────────────────────────────────────────────────────────────────────

async fn rpc_call(
    State(state): State<WebState>,
    AxumPath(command): AxumPath<String>,
    body: axum::body::Bytes,
) -> Response {
    if body.len() > MAX_RPC_BODY_BYTES {
        return error_response(StatusCode::PAYLOAD_TOO_LARGE, "RPC body too large");
    }
    let args: Value = if body.is_empty() {
        json!({})
    } else {
        match serde_json::from_slice(&body) {
            Ok(value) => value,
            Err(err) => {
                return error_response(StatusCode::BAD_REQUEST, &format!("Invalid JSON: {err}"))
            }
        }
    };
    match rpc::dispatch(&state.ctx, &command, args).await {
        Ok(result) => Json(json!({ "ok": true, "result": result })).into_response(),
        Err(err) if err == rpc::UNKNOWN_COMMAND => error_response(
            StatusCode::NOT_FOUND,
            &format!("Unknown command: {command}"),
        ),
        // Command errors are ordinary results for the frontend (it rejects
        // the invoke() promise with the string), so keep HTTP 200.
        Err(err) => Json(json!({ "ok": false, "error": err })).into_response(),
    }
}

// ── events ──────────────────────────────────────────────────────────────────

async fn events(
    State(state): State<WebState>,
) -> Sse<impl futures::Stream<Item = Result<Event, std::convert::Infallible>>> {
    let receiver = state.ctx.subscribe();
    let stream = BroadcastStream::new(receiver).filter_map(|item| async move {
        match item {
            Ok(envelope) => Event::default().json_data(&envelope).ok().map(Ok),
            // Lagged: the client fell behind; skip and continue.
            Err(_) => None,
        }
    });
    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keepalive"),
    )
}

// ── files ───────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct FileQuery {
    path: String,
    #[serde(default)]
    download: Option<String>,
}

fn allowed_roots(ctx: &AppCtx) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = crate::app_commands::load_agent_projects(ctx)
        .into_iter()
        .map(|p| PathBuf::from(p.path))
        .collect();
    roots.push(ctx.app_data_dir());
    let current = crate::clip_server::current_project_path();
    if !current.is_empty() {
        roots.push(PathBuf::from(current));
    }
    roots
}

fn path_is_allowed(ctx: &AppCtx, candidate: &Path) -> bool {
    let Ok(canonical) = candidate.canonicalize() else {
        return false;
    };
    allowed_roots(ctx).iter().any(|root| {
        root.canonicalize()
            .map(|root| canonical.starts_with(root))
            .unwrap_or(false)
    })
}

async fn file(
    State(state): State<WebState>,
    Query(query): Query<FileQuery>,
    req: Request,
) -> Response {
    let path = PathBuf::from(&query.path);
    if !path.is_absolute() {
        return error_response(StatusCode::BAD_REQUEST, "path must be absolute");
    }
    let ctx = state.ctx.clone();
    let check_path = path.clone();
    let allowed = crate::rt::spawn_blocking(move || path_is_allowed(&ctx, &check_path))
        .await
        .unwrap_or(false);
    if !allowed {
        return error_response(StatusCode::FORBIDDEN, "path is outside every known project");
    }
    if !path.is_file() {
        return error_response(StatusCode::NOT_FOUND, "file not found");
    }
    // Rebuild a GET request without the query so ServeFile ignores it.
    let mut inner = Request::builder().method(Method::GET).uri("/");
    for (name, value) in req.headers() {
        if matches!(*name, header::RANGE | header::IF_MODIFIED_SINCE | header::IF_NONE_MATCH) {
            inner = inner.header(name, value);
        }
    }
    let inner = match inner.body(Body::empty()) {
        Ok(r) => r,
        Err(_) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, "bad request"),
    };
    let mut response = match ServeFile::new(&path).oneshot(inner).await {
        Ok(r) => r.into_response(),
        Err(_) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, "failed to read file"),
    };
    if query.download.as_deref().is_some_and(|v| v != "0" && !v.is_empty()) {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "download".into());
        let disposition = format!(
            "attachment; filename*=UTF-8''{}",
            percent_encode(&name)
        );
        if let Ok(v) = HeaderValue::from_str(&disposition) {
            response.headers_mut().insert(header::CONTENT_DISPOSITION, v);
        }
    }
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=0"));
    response
}

fn percent_encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn sanitize_file_name(raw: &str) -> String {
    let name = raw.rsplit(['/', '\\']).next().unwrap_or(raw).trim();
    let cleaned: String = name
        .chars()
        .filter(|c| !c.is_control() && *c != '\0')
        .collect();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        "upload.bin".to_string()
    } else {
        cleaned
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadedFile {
    name: String,
    path: String,
    size: u64,
}

/// Multipart upload. Every file part is stored under
/// `<data_dir>/uploads/<uuid>/<original name>` and its absolute server path
/// returned, so the frontend can hand it to the same import flow the
/// desktop file picker feeds.
async fn upload(State(state): State<WebState>, mut multipart: Multipart) -> Response {
    let batch_dir = state
        .ctx
        .app_data_dir()
        .join("uploads")
        .join(uuid::Uuid::new_v4().simple().to_string());
    if let Err(err) = tokio::fs::create_dir_all(&batch_dir).await {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("cannot create upload dir: {err}"),
        );
    }
    let mut files = Vec::new();
    loop {
        let field = match multipart.next_field().await {
            Ok(Some(field)) => field,
            Ok(None) => break,
            Err(err) => {
                return error_response(StatusCode::BAD_REQUEST, &format!("multipart error: {err}"))
            }
        };
        let Some(file_name) = field.file_name().map(sanitize_file_name) else {
            continue;
        };
        // Preserve relative folder structure when the client sends it
        // (`webkitdirectory` uploads) so folder imports keep their layout.
        let relative = field
            .name()
            .filter(|n| n.starts_with("dir:"))
            .map(|n| n.trim_start_matches("dir:").to_string());
        let mut target = batch_dir.clone();
        if let Some(rel) = relative {
            for part in rel.split(['/', '\\']) {
                if part.is_empty() || part == "." || part == ".." {
                    continue;
                }
                target.push(part);
            }
        } else {
            target.push(&file_name);
        }
        if let Some(parent) = target.parent() {
            if let Err(err) = tokio::fs::create_dir_all(parent).await {
                return error_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    &format!("cannot create upload dir: {err}"),
                );
            }
        }
        let mut out = match tokio::fs::File::create(&target).await {
            Ok(f) => f,
            Err(err) => {
                return error_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    &format!("cannot write upload: {err}"),
                )
            }
        };
        let mut size = 0u64;
        let mut field = field;
        loop {
            match field.chunk().await {
                Ok(Some(chunk)) => {
                    size += chunk.len() as u64;
                    if let Err(err) = tokio::io::AsyncWriteExt::write_all(&mut out, &chunk).await {
                        return error_response(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            &format!("cannot write upload: {err}"),
                        );
                    }
                }
                Ok(None) => break,
                Err(err) => {
                    return error_response(
                        StatusCode::BAD_REQUEST,
                        &format!("upload interrupted: {err}"),
                    )
                }
            }
        }
        let _ = tokio::io::AsyncWriteExt::flush(&mut out).await;
        files.push(UploadedFile {
            name: file_name,
            path: target.to_string_lossy().into_owned(),
            size,
        });
    }
    Json(json!({
        "ok": true,
        "batchDir": batch_dir.to_string_lossy(),
        "files": files,
    }))
    .into_response()
}

// ── outbound proxy ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProxyRequest {
    url: String,
    method: Option<String>,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
    body_base64: Option<String>,
    accept_invalid_certs: Option<bool>,
}

const HOP_BY_HOP: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length",
];

/// Forward a request to an arbitrary URL on behalf of the browser, the way
/// `tauri-plugin-http` does for the desktop webview. Needed because many
/// LLM endpoints reject browser-origin requests at CORS preflight, and so
/// API keys stay on the server. Only authenticated users can reach it.
async fn proxy(State(_state): State<WebState>, Json(req): Json<ProxyRequest>) -> Response {
    let url = match reqwest::Url::parse(&req.url) {
        Ok(url) if matches!(url.scheme(), "http" | "https") => url,
        _ => return proxy_error(StatusCode::BAD_REQUEST, "invalid or unsupported URL"),
    };
    let method = req
        .method
        .as_deref()
        .unwrap_or("GET")
        .parse::<reqwest::Method>()
        .unwrap_or(reqwest::Method::GET);
    // A fresh client per request so proxy env changes made at runtime
    // (Settings → Network) apply immediately, matching desktop behaviour.
    let mut builder = reqwest::Client::builder().connect_timeout(PROXY_CONNECT_TIMEOUT);
    if req.accept_invalid_certs.unwrap_or(false) {
        builder = builder.danger_accept_invalid_certs(true);
    }
    let client = match builder.build() {
        Ok(c) => c,
        Err(err) => {
            return proxy_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("cannot build HTTP client: {err}"),
            )
        }
    };
    let mut request = client.request(method, url);
    if let Some(headers) = req.headers {
        for (name, value) in headers {
            if HOP_BY_HOP.contains(&name.to_ascii_lowercase().as_str()) {
                continue;
            }
            if let (Ok(n), Ok(v)) = (
                reqwest::header::HeaderName::from_bytes(name.as_bytes()),
                reqwest::header::HeaderValue::from_str(&value),
            ) {
                request = request.header(n, v);
            }
        }
    }
    if let Some(b64) = req.body_base64 {
        use base64::Engine;
        match base64::engine::general_purpose::STANDARD.decode(b64) {
            Ok(bytes) => request = request.body(bytes),
            Err(_) => return proxy_error(StatusCode::BAD_REQUEST, "invalid base64 body"),
        }
    } else if let Some(body) = req.body {
        request = request.body(body);
    }
    let upstream = match request.send().await {
        Ok(r) => r,
        Err(err) => return proxy_error(StatusCode::BAD_GATEWAY, &format!("{err}")),
    };
    let status = upstream.status().as_u16();
    let mut forwarded: HashMap<String, String> = HashMap::new();
    for (name, value) in upstream.headers() {
        let lname = name.as_str().to_ascii_lowercase();
        if HOP_BY_HOP.contains(&lname.as_str()) || lname == "content-encoding" {
            continue;
        }
        if let Ok(v) = value.to_str() {
            forwarded.insert(lname, v.to_string());
        }
    }
    let headers_json = serde_json::to_string(&forwarded).unwrap_or_else(|_| "{}".into());
    let headers_b64 = {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(headers_json)
    };
    let body = Body::from_stream(upstream.bytes_stream());
    let mut response = Response::new(body);
    let h = response.headers_mut();
    h.insert(
        HeaderName::from_static("x-proxy-status"),
        HeaderValue::from(status),
    );
    if let Ok(v) = HeaderValue::from_str(&headers_b64) {
        h.insert(HeaderName::from_static("x-proxy-headers"), v);
    }
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(
        HeaderName::from_static("x-accel-buffering"),
        HeaderValue::from_static("no"),
    );
    response
}

fn proxy_error(status: StatusCode, message: &str) -> Response {
    let mut response = error_response(status, message);
    response.headers_mut().insert(
        HeaderName::from_static("x-proxy-error"),
        HeaderValue::from_static("1"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cookie_parsing_finds_session() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("a=1; llm_wiki_session=abc; b=2"),
        );
        assert_eq!(cookie_value(&headers, SESSION_COOKIE).as_deref(), Some("abc"));
        assert_eq!(cookie_value(&headers, "missing"), None);
    }

    #[test]
    fn options_parse_flags() {
        let args = vec![
            "bin".to_string(),
            "--host".into(),
            "0.0.0.0".into(),
            "--port".into(),
            "9000".into(),
            "--password".into(),
            "secret".into(),
        ];
        let options = WebServerOptions::from_env_and_args(&args).unwrap();
        assert_eq!(options.host, "0.0.0.0");
        assert_eq!(options.port, 9000);
        assert_eq!(options.password.as_deref(), Some("secret"));
    }

    #[test]
    fn file_name_sanitized() {
        assert_eq!(sanitize_file_name("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_file_name("C:\\Users\\x\\report.pdf"), "report.pdf");
        assert_eq!(sanitize_file_name(".."), "upload.bin");
    }
}
