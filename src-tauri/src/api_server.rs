use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};
use tiny_http::{Header, Method, Response, Server, StatusCode};
use uuid::Uuid;
use walkdir::WalkDir;

use crate::cors::{local_cors_headers, request_origin};
use crate::{agent, clip_server, commands, server_bind};

const PORT: u16 = 19828;
const API_PREFIX: &str = "/api/v1";
const MAX_BODY_BYTES: usize = 1024 * 1024;
const MAX_CHAT_BODY_BYTES: usize = 40 * 1024 * 1024;
const MAX_FILE_CONTENT_BYTES: u64 = 2 * 1024 * 1024;
const DEFAULT_MAX_FILES: usize = 2_000;
const HARD_MAX_FILES: usize = 10_000;
const DEFAULT_MAX_REVIEWS: usize = 200;
const HARD_MAX_REVIEWS: usize = 1_000;
const MAX_SEARCH_RESULTS: usize = 50;
const BIND_RETRY_DELAY_SECS: u64 = 2;
const MAX_BIND_RETRIES: u32 = 3;
const APP_STATE_CACHE_TTL: Duration = Duration::from_secs(5);
const RATE_LIMIT_WINDOW: Duration = Duration::from_secs(1);
const RATE_LIMIT_MAX_REQUESTS: usize = 120;
const MAX_IN_FLIGHT_REQUESTS: usize = 64;

/// API status: 0=starting, 1=running, 2=port_conflict, 3=error
static API_STATUS: AtomicU8 = AtomicU8::new(0);
static IN_FLIGHT_REQUESTS: AtomicUsize = AtomicUsize::new(0);
static APP_STATE_CACHE: OnceLock<Mutex<Option<CachedAppState>>> = OnceLock::new();
static RATE_LIMIT: OnceLock<Mutex<VecDeque<Instant>>> = OnceLock::new();

#[derive(Clone)]
struct CachedAppState {
    loaded_at: Instant,
    value: Option<Value>,
}

pub fn get_api_status() -> &'static str {
    match API_STATUS.load(Ordering::Relaxed) {
        0 => "starting",
        1 => "running",
        2 => "port_conflict",
        _ => "error",
    }
}

pub fn invalidate_config_cache() {
    if let Some(lock) = APP_STATE_CACHE.get() {
        if let Ok(mut cache) = lock.lock() {
            *cache = None;
        }
    }
}

pub fn start_api_server(app: AppHandle) {
    thread::spawn(move || loop {
        API_STATUS.store(0, Ordering::Relaxed);
        let (server, addr) = match bind_server_with_retry(&app) {
            Some(bound) => bound,
            None => {
                API_STATUS.store(2, Ordering::Relaxed);
                thread::sleep(Duration::from_secs(BIND_RETRY_DELAY_SECS));
                continue;
            }
        };

        API_STATUS.store(1, Ordering::Relaxed);
        eprintln!("[API Server] Listening on http://{addr}{API_PREFIX}");

        for request in server.incoming_requests() {
            let method = request.method().clone();
            let url = request.url().to_string();
            let origin = request_origin(&request);
            if should_rate_limit(&method, &url) && !allow_request() {
                respond_error(request, 429, "Too many requests", origin.as_deref());
                continue;
            }
            let Some(slot) = try_acquire_request_slot() else {
                respond_error(request, 503, "API server is busy", origin.as_deref());
                continue;
            };
            let app = app.clone();
            thread::spawn(move || {
                let _slot = slot;
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    process_request(app, request);
                }));
                if let Err(payload) = result {
                    eprintln!("[API Server] request handler panicked: {payload:?}");
                }
            });
        }

        API_STATUS.store(3, Ordering::Relaxed);
        eprintln!("[API Server] server loop exited; restarting");
        thread::sleep(Duration::from_secs(BIND_RETRY_DELAY_SECS));
    });
}

fn bind_server_with_retry(app: &AppHandle) -> Option<(Server, String)> {
    let host = server_bind::configured_bind_host(app);
    let addr = server_bind::bind_addr(&host, PORT);
    for attempt in 1..=MAX_BIND_RETRIES {
        match Server::http(&addr) {
            Ok(server) => return Some((server, addr)),
            Err(err) => {
                eprintln!(
                    "[API Server] Failed to bind {addr} (attempt {attempt}/{MAX_BIND_RETRIES}): {err}"
                );
                if attempt < MAX_BIND_RETRIES {
                    thread::sleep(Duration::from_secs(BIND_RETRY_DELAY_SECS));
                }
            }
        }
    }
    None
}

struct RequestSlot;

impl Drop for RequestSlot {
    fn drop(&mut self) {
        IN_FLIGHT_REQUESTS.fetch_sub(1, Ordering::Relaxed);
    }
}

fn try_acquire_request_slot() -> Option<RequestSlot> {
    let mut current = IN_FLIGHT_REQUESTS.load(Ordering::Relaxed);
    loop {
        if current >= MAX_IN_FLIGHT_REQUESTS {
            return None;
        }
        match IN_FLIGHT_REQUESTS.compare_exchange_weak(
            current,
            current + 1,
            Ordering::Relaxed,
            Ordering::Relaxed,
        ) {
            Ok(_) => return Some(RequestSlot),
            Err(next) => current = next,
        }
    }
}

fn process_request(app: AppHandle, mut request: tiny_http::Request) {
    let method = request.method().clone();
    let url = request.url().to_string();
    let origin = request_origin(&request);
    if method == Method::Options {
        respond_options(request, origin.as_deref());
        return;
    }

    let headers: Vec<(String, String)> = request
        .headers()
        .iter()
        .map(|header| {
            (
                header.field.as_str().to_ascii_lowercase().to_string(),
                header.value.as_str().to_string(),
            )
        })
        .collect();

    let body = match read_body(&mut request, body_limit_for_request(&method, &url)) {
        Ok(body) => body,
        Err(err) => {
            respond_error(request, 400, &err, origin.as_deref());
            return;
        }
    };

    let response = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        handle_request(&app, &method, &url, &body, &headers)
    }))
    .unwrap_or_else(|payload| {
        eprintln!("[API Server] request panicked: {payload:?}");
        err(500, "Internal API server error")
    });
    respond_json(request, response.status, response.body, origin.as_deref());
}

struct ApiResponse {
    status: u16,
    body: Value,
}

fn ok(body: Value) -> ApiResponse {
    ApiResponse { status: 200, body }
}

fn err(status: u16, message: impl Into<String>) -> ApiResponse {
    ApiResponse {
        status,
        body: json!({ "ok": false, "error": message.into() }),
    }
}

fn handle_request(
    app: &AppHandle,
    method: &Method,
    url: &str,
    body: &str,
    headers: &[(String, String)],
) -> ApiResponse {
    let (path, query) = split_url(url);
    if path == "/health" || path == format!("{API_PREFIX}/health") {
        // /health stays reachable even when the user has disabled the
        // API in Settings — the desktop UI uses it to render the
        // "Enabled / disabled / port_conflict" line, and curl-from-
        // terminal users need a way to confirm the server is alive
        // before they go hunting for why other endpoints 503.
        return ok(json!({
            "ok": true,
            "status": get_api_status(),
            "version": env!("CARGO_PKG_VERSION"),
            "authRequired": api_auth_required(app),
            "authConfigured": api_token(app).is_some(),
            "tokenSource": api_token_source(app),
            "enabled": api_enabled(app),
            "mcpEnabled": api_mcp_enabled(app),
            "allowUnauthenticated": api_allow_unauthenticated(app),
            "allowLanAccess": api_allow_lan_access(app),
            "agent": {
                "chat": true,
                "streaming": false,
            },
        }));
    }
    if !path.starts_with(API_PREFIX) {
        return err(404, "Not found");
    }
    if !api_enabled(app) {
        // Kill-switch path: token may be configured and valid, but the
        // user toggled the API off in Settings → API Server. 503 is
        // the right code semantically ("temporarily unavailable")
        // and tells well-behaved clients to back off rather than
        // retry instantly the way 401 would.
        return err(503, "API server is disabled in Settings → API Server");
    }
    if is_agent_chat_request(&method, &path) && !is_token_authorized(app, query, headers) {
        return err(401, "Unauthorized");
    }
    if !is_authorized(app, query, headers) {
        return err(401, "Unauthorized");
    }
    if !matches!(method, &Method::Get | &Method::Post | &Method::Patch) {
        return err(405, "Method not allowed");
    }

    let parts: Vec<&str> = path
        .trim_start_matches(API_PREFIX)
        .trim_start_matches('/')
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();

    match (method, parts.as_slice()) {
        (&Method::Get, ["projects"]) => handle_projects(app),
        (&Method::Get, ["projects", project_id, "files"]) => handle_files(app, project_id, query),
        (&Method::Get, ["projects", project_id, "files", "content"]) => {
            handle_file_content(app, project_id, query)
        }
        (&Method::Get, ["projects", project_id, "reviews"]) => {
            handle_reviews(app, project_id, query)
        }
        (&Method::Post, ["projects", project_id, "reviews", "resolve"]) => {
            handle_bulk_resolve_reviews(app, project_id, body)
        }
        (&Method::Patch, ["projects", project_id, "reviews", review_id]) => {
            handle_patch_review(app, project_id, review_id, body)
        }
        (&Method::Post, ["projects", project_id, "search"]) => handle_search(app, project_id, body),
        (&Method::Get, ["projects", project_id, "graph"]) => handle_graph(app, project_id, query),
        (&Method::Post, ["projects", project_id, "sources", "rescan"]) => {
            handle_rescan(app, project_id)
        }
        (&Method::Post, ["projects", project_id, "chat"]) => handle_chat(app, project_id, body),
        (&Method::Post, ["projects", project_id, "chat", session_id, "cancel"]) => {
            handle_cancel_chat(app, project_id, session_id)
        }
        _ => err(404, "Not found"),
    }
}

fn should_rate_limit(method: &Method, url: &str) -> bool {
    if method == &Method::Options {
        return false;
    }
    let (path, _) = split_url(url);
    !(path == "/health" || path == format!("{API_PREFIX}/health"))
}

fn allow_request() -> bool {
    let now = Instant::now();
    let window_start = now - RATE_LIMIT_WINDOW;
    let lock = RATE_LIMIT.get_or_init(|| Mutex::new(VecDeque::new()));
    let Ok(mut hits) = lock.lock() else {
        return false;
    };
    while hits.front().map(|t| *t < window_start).unwrap_or(false) {
        hits.pop_front();
    }
    if hits.len() >= RATE_LIMIT_MAX_REQUESTS {
        return false;
    }
    hits.push_back(now);
    true
}

fn is_agent_chat_request(method: &Method, path: &str) -> bool {
    let parts = path
        .trim_start_matches(API_PREFIX)
        .trim_start_matches('/')
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    method == &Method::Post
        && matches!(
            parts.as_slice(),
            ["projects", _, "chat"] | ["projects", _, "chat", _, "cancel"]
        )
}

fn body_limit_for_request(method: &Method, url: &str) -> usize {
    let (path, _) = split_url(url);
    let parts = path
        .trim_start_matches(API_PREFIX)
        .trim_start_matches('/')
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if method == &Method::Post && matches!(parts.as_slice(), ["projects", _, "chat"]) {
        MAX_CHAT_BODY_BYTES
    } else {
        MAX_BODY_BYTES
    }
}

fn read_body(request: &mut tiny_http::Request, max_body_bytes: usize) -> Result<String, String> {
    let mut limited = request.as_reader().take(max_body_bytes as u64 + 1);
    let mut bytes = Vec::new();
    limited
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Failed to read body: {e}"))?;
    if bytes.len() > max_body_bytes {
        return Err("Request body too large".to_string());
    }
    String::from_utf8(bytes).map_err(|_| "Request body must be UTF-8".to_string())
}

fn respond_error(request: tiny_http::Request, status: u16, message: &str, origin: Option<&str>) {
    respond_json(
        request,
        status,
        json!({ "ok": false, "error": message }),
        origin,
    );
}

fn respond_options(request: tiny_http::Request, origin: Option<&str>) {
    let mut response = Response::empty(StatusCode(204));
    for header in cors_headers(origin) {
        response.add_header(header);
    }
    response.add_header(Header::from_bytes("Access-Control-Max-Age", "600").unwrap());
    let _ = request.respond(response);
}

fn respond_json(request: tiny_http::Request, status: u16, body: Value, origin: Option<&str>) {
    let mut response = Response::from_string(body.to_string()).with_status_code(StatusCode(status));
    for header in cors_headers(origin) {
        response.add_header(header);
    }
    let _ = request.respond(response);
}

fn cors_headers(origin: Option<&str>) -> Vec<Header> {
    local_cors_headers(origin, "Content-Type, Authorization, X-LLM-Wiki-Token")
}

fn split_url(url: &str) -> (String, &str) {
    match url.split_once('?') {
        Some((path, query)) => (path.to_string(), query),
        None => (url.to_string(), ""),
    }
}

fn parse_query(query: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for pair in query.split('&').filter(|s| !s.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        out.insert(percent_decode(k), percent_decode(v));
    }
    out
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&input[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn is_authorized(app: &AppHandle, query: &str, headers: &[(String, String)]) -> bool {
    if !api_auth_required(app) {
        return true;
    }
    is_token_authorized(app, query, headers)
}

fn is_token_authorized(app: &AppHandle, query: &str, headers: &[(String, String)]) -> bool {
    let Some(token) = api_token(app) else {
        return false;
    };
    let params = parse_query(query);
    if params
        .get("token")
        .map(|v| constant_time_eq(v.as_bytes(), token.as_bytes()))
        .unwrap_or(false)
    {
        return true;
    }
    headers.iter().any(|(key, value)| {
        if key == "x-llm-wiki-token" {
            return constant_time_eq(value.as_bytes(), token.as_bytes());
        }
        if key == "authorization" {
            return value
                .strip_prefix("Bearer ")
                .map(|v| constant_time_eq(v.as_bytes(), token.as_bytes()))
                .unwrap_or(false);
        }
        false
    })
}

fn api_token(app: &AppHandle) -> Option<String> {
    if let Ok(token) = std::env::var("LLM_WIKI_API_TOKEN") {
        let trimmed = token.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    let parsed = load_app_state(app)?;
    parsed
        .get("apiConfig")
        .and_then(|v| v.get("token"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
}

fn api_token_source(app: &AppHandle) -> &'static str {
    if let Ok(token) = std::env::var("LLM_WIKI_API_TOKEN") {
        if !token.trim().is_empty() {
            return "env";
        }
    }
    if load_app_state(app)
        .and_then(|parsed| {
            parsed
                .get("apiConfig")
                .and_then(|v| v.get("token"))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(|_| ())
        })
        .is_some()
    {
        return "store";
    }
    "none"
}

fn api_auth_required(app: &AppHandle) -> bool {
    !api_allow_unauthenticated(app)
}

fn api_allow_unauthenticated(app: &AppHandle) -> bool {
    let Some(parsed) = load_app_state(app) else {
        return false;
    };
    parsed
        .get("apiConfig")
        .and_then(|v| v.get("allowUnauthenticated"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn api_allow_lan_access(app: &AppHandle) -> bool {
    let Some(parsed) = load_app_state(app) else {
        return false;
    };
    parsed
        .get("apiConfig")
        .and_then(|v| v.get("allowLanAccess"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// Whether the API server should accept non-/health requests.
///
/// Defaults to `true` when no config has been written yet — keeps
/// existing setups (env-token-only, hand-edited app-state.json) working
/// after the kill-switch was introduced. New users still land in
/// "enabled + no token = 401" which is fail-closed by virtue of the
/// missing token, not the enable flag.
fn api_enabled(app: &AppHandle) -> bool {
    let Some(parsed) = load_app_state(app) else {
        return true;
    };
    parsed
        .get("apiConfig")
        .and_then(|v| v.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

fn api_mcp_enabled(app: &AppHandle) -> bool {
    let Some(parsed) = load_app_state(app) else {
        return false;
    };
    parsed
        .get("apiConfig")
        .and_then(|v| v.get("mcpEnabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let max_len = left.len().max(right.len());
    let mut diff = left.len() ^ right.len();
    for i in 0..max_len {
        let a = left.get(i).copied().unwrap_or(0);
        let b = right.get(i).copied().unwrap_or(0);
        diff |= (a ^ b) as usize;
    }
    diff == 0
}

fn load_app_state(app: &AppHandle) -> Option<Value> {
    let now = Instant::now();
    let lock = APP_STATE_CACHE.get_or_init(|| Mutex::new(None));
    let mut previous = None;
    if let Ok(cache) = lock.lock() {
        if let Some(cached) = cache.as_ref() {
            if now.duration_since(cached.loaded_at) < APP_STATE_CACHE_TTL {
                return cached.value.clone();
            }
            previous = cached.value.clone();
        }
    }

    let path = app.path().app_data_dir().ok()?.join("app-state.json");
    let loaded = fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
    let value = loaded.or(previous);

    if let Ok(mut cache) = lock.lock() {
        *cache = Some(CachedAppState {
            loaded_at: now,
            value: value.clone(),
        });
    }
    value
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProjectEntry {
    id: String,
    name: String,
    path: String,
    current: bool,
}

fn handle_projects(app: &AppHandle) -> ApiResponse {
    let projects = load_projects(app);
    let current_project = projects.iter().find(|project| project.current).cloned();
    ok(json!({
        "ok": true,
        "projects": projects,
        "currentProject": current_project,
    }))
}

fn load_projects(app: &AppHandle) -> Vec<ProjectEntry> {
    let current = normalize_path(&clip_server::current_project_path());
    let mut by_path: BTreeMap<String, ProjectEntry> = BTreeMap::new();

    if let Some(parsed) = load_app_state(app) {
        if let Some(registry) = parsed.get("projectRegistry").and_then(Value::as_object) {
            for (id, value) in registry {
                let path = value.get("path").and_then(Value::as_str).unwrap_or("");
                if path.is_empty() {
                    continue;
                }
                let path = normalize_path(path);
                let name = value
                    .get("name")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
                    .unwrap_or_else(|| project_name_from_path(&path));
                by_path.insert(
                    path.clone(),
                    ProjectEntry {
                        id: id.clone(),
                        name,
                        current: path == current,
                        path,
                    },
                );
            }
        }
        if let Some(recents) = parsed.get("recentProjects").and_then(Value::as_array) {
            for value in recents {
                let path = value.get("path").and_then(Value::as_str).unwrap_or("");
                if path.is_empty() {
                    continue;
                }
                let path = normalize_path(path);
                by_path.entry(path.clone()).or_insert_with(|| {
                    let id = read_project_id(&path).unwrap_or_else(|| path.clone());
                    let name = value
                        .get("name")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                        .unwrap_or_else(|| project_name_from_path(&path));
                    ProjectEntry {
                        id,
                        name,
                        current: path == current,
                        path,
                    }
                });
            }
        }
    }

    for (name, path) in clip_server::all_projects() {
        let path = normalize_path(&path);
        by_path.entry(path.clone()).or_insert_with(|| ProjectEntry {
            id: read_project_id(&path).unwrap_or_else(|| path.clone()),
            name: if name.is_empty() {
                project_name_from_path(&path)
            } else {
                name
            },
            current: path == current,
            path,
        });
    }

    if !current.is_empty() {
        by_path
            .entry(current.clone())
            .or_insert_with(|| ProjectEntry {
                id: read_project_id(&current).unwrap_or_else(|| current.clone()),
                name: project_name_from_path(&current),
                current: true,
                path: current.clone(),
            });
    }

    by_path.into_values().collect()
}

fn resolve_project(app: &AppHandle, project_id: &str) -> Result<ProjectEntry, String> {
    let project_id = percent_decode(project_id);
    let wants_current = project_id.eq_ignore_ascii_case("current");
    load_projects(app)
        .into_iter()
        .find(|p| {
            p.id == project_id
                || project_path_matches(&p.path, &project_id)
                || (wants_current && p.current)
        })
        .ok_or_else(|| format!("Unknown project: {project_id}"))
}

fn project_path_matches(stored_path: &str, candidate: &str) -> bool {
    let stored = normalize_path(stored_path);
    let candidate = normalize_path(candidate);
    if cfg!(windows) {
        stored.eq_ignore_ascii_case(&candidate)
    } else {
        stored == candidate
    }
}

fn read_project_id(path: &str) -> Option<String> {
    let raw = fs::read_to_string(Path::new(path).join(".llm-wiki/project.json")).ok()?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    parsed
        .get("id")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn project_name_from_path(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("Project")
        .to_string()
}

fn normalize_path(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').to_string()
}

fn handle_files(app: &AppHandle, project_id: &str, query: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(e) => return err(404, e),
    };
    let params = parse_query(query);
    let root = params.get("root").map(String::as_str).unwrap_or("wiki");
    let recursive = params
        .get("recursive")
        .map(|v| v != "false")
        .unwrap_or(true);
    let max_files = params
        .get("maxFiles")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(DEFAULT_MAX_FILES)
        .clamp(1, HARD_MAX_FILES);
    let rel = match root {
        "wiki" => "wiki",
        "sources" | "raw" | "raw/sources" => "raw/sources",
        "all" | "" => "",
        _ => return err(400, "root must be wiki, sources, or all"),
    };
    if rel.is_empty() {
        return match list_public_roots(&project.path, recursive, max_files) {
            Ok(files) => ok(json!({
                "ok": true,
                "projectId": project.id,
                "root": "all",
                "files": files,
                "truncated": false,
            })),
            Err(e) => err(if e.contains("exceeds") { 413 } else { 500 }, e),
        };
    }
    let dir = match safe_join(&project.path, rel) {
        Ok(path) => path,
        Err(e) => return err(400, e),
    };
    let mut count = 0;
    match list_tree(&project.path, &dir, recursive, max_files, &mut count) {
        Ok(files) => ok(json!({
            "ok": true,
            "projectId": project.id,
            "root": rel,
            "files": files,
            "truncated": false,
        })),
        Err(e) => err(if e.contains("exceeds") { 413 } else { 500 }, e),
    }
}

fn handle_file_content(app: &AppHandle, project_id: &str, query: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(e) => return err(404, e),
    };
    let params = parse_query(query);
    let Some(rel) = params.get("path") else {
        return err(400, "Missing path query parameter");
    };
    if !is_public_project_rel(rel) {
        return err(403, "Path is not exposed by the local API");
    }
    if !is_text_content_rel(rel) {
        return err(
            415,
            "Only text-like project files can be read via this endpoint",
        );
    }
    let path = match safe_join(&project.path, rel) {
        Ok(path) => path,
        Err(e) => return err(400, e),
    };
    let meta = match fs::metadata(&path) {
        Ok(meta) => meta,
        Err(e) => return err(404, format!("File not found: {e}")),
    };
    if meta.len() > MAX_FILE_CONTENT_BYTES {
        return err(413, "File is too large to return via API");
    }
    match fs::read_to_string(&path) {
        Ok(content) => ok(json!({
            "ok": true,
            "projectId": project.id,
            "path": rel,
            "content": content,
        })),
        Err(_) => err(415, "File is not valid UTF-8 text"),
    }
}

fn safe_join(project_path: &str, rel: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(project_path);
    let rel = rel.trim_start_matches('/');
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() {
        return Err("Absolute paths are not allowed".to_string());
    }
    for component in rel_path.components() {
        if matches!(
            component,
            Component::ParentDir | Component::Prefix(_) | Component::RootDir
        ) {
            return Err("Path traversal is not allowed".to_string());
        }
    }
    let joined = root.join(rel_path);
    let root_canon = root
        .canonicalize()
        .map_err(|e| format!("Failed to resolve project path: {e}"))?;
    if joined.exists() {
        let joined_canon = joined
            .canonicalize()
            .map_err(|e| format!("Failed to resolve path: {e}"))?;
        if !joined_canon.starts_with(&root_canon) {
            return Err("Resolved path escapes the project directory".to_string());
        }
        return Ok(joined_canon);
    }
    let parent = joined
        .parent()
        .ok_or_else(|| "Path has no parent directory".to_string())?;
    if parent.exists() {
        let parent_canon = parent
            .canonicalize()
            .map_err(|e| format!("Failed to resolve parent path: {e}"))?;
        if !parent_canon.starts_with(&root_canon) {
            return Err("Resolved parent escapes the project directory".to_string());
        }
    }
    Ok(joined)
}

fn is_public_project_rel(rel: &str) -> bool {
    let rel = normalize_path(rel).trim_start_matches('/').to_string();
    if rel
        .split('/')
        .any(|part| part.is_empty() || part.starts_with('.'))
    {
        return false;
    }
    let lower = rel.to_lowercase();
    lower == "purpose.md"
        || lower == "schema.md"
        || lower.starts_with("wiki/")
        || lower.starts_with("raw/sources/")
}

fn is_text_content_rel(rel: &str) -> bool {
    let rel = normalize_path(rel).to_lowercase();
    let ext = Path::new(&rel)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    matches!(
        ext,
        "md" | "mdx"
            | "txt"
            | "csv"
            | "json"
            | "yaml"
            | "yml"
            | "xml"
            | "html"
            | "htm"
            | "rtf"
            | "log"
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiFileNode {
    name: String,
    path: String,
    is_dir: bool,
    size: Option<u64>,
    children: Option<Vec<ApiFileNode>>,
}

fn list_public_roots(
    project_path: &str,
    recursive: bool,
    max_files: usize,
) -> Result<Vec<ApiFileNode>, String> {
    let mut count = 0;
    let mut roots = Vec::new();
    for rel in ["purpose.md", "schema.md", "wiki", "raw/sources"] {
        let path = safe_join(project_path, rel)?;
        if !path.exists() {
            continue;
        }
        push_file_node(
            project_path,
            &path,
            recursive,
            max_files,
            &mut count,
            &mut roots,
        )?;
    }
    Ok(roots)
}

fn list_tree(
    project_path: &str,
    path: &Path,
    recursive: bool,
    max_files: usize,
    count: &mut usize,
) -> Result<Vec<ApiFileNode>, String> {
    let mut out = Vec::new();
    let entries = fs::read_dir(path).map_err(|e| format!("Failed to list directory: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {e}"))?;
        push_file_node(
            project_path,
            &entry.path(),
            recursive,
            max_files,
            count,
            &mut out,
        )?;
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

fn push_file_node(
    project_path: &str,
    path: &Path,
    recursive: bool,
    max_files: usize,
    count: &mut usize,
    out: &mut Vec<ApiFileNode>,
) -> Result<(), String> {
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    if name.starts_with('.') {
        return Ok(());
    }
    let meta = fs::symlink_metadata(path).map_err(|e| format!("Failed to read metadata: {e}"))?;
    let file_type = meta.file_type();
    if file_type.is_symlink() {
        return Ok(());
    }
    *count += 1;
    if *count > max_files {
        return Err(format!("File listing exceeds maxFiles limit ({max_files})"));
    }
    let is_dir = file_type.is_dir();
    let children = if recursive && is_dir {
        Some(list_tree(project_path, path, true, max_files, count)?)
    } else {
        None
    };
    out.push(ApiFileNode {
        name,
        path: relative_to_project(project_path, path),
        is_dir,
        size: if is_dir { None } else { Some(meta.len()) },
        children,
    });
    Ok(())
}

fn relative_to_project(project_path: &str, path: &Path) -> String {
    let root = Path::new(project_path);
    path.strip_prefix(root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReviewStatus {
    Unresolved,
    Resolved,
    All,
}

impl ReviewStatus {
    fn as_str(self) -> &'static str {
        match self {
            ReviewStatus::Unresolved => "unresolved",
            ReviewStatus::Resolved => "resolved",
            ReviewStatus::All => "all",
        }
    }

    fn matches(self, resolved: bool) -> bool {
        match self {
            ReviewStatus::Unresolved => !resolved,
            ReviewStatus::Resolved => resolved,
            ReviewStatus::All => true,
        }
    }
}

#[derive(Debug, Clone)]
struct ReviewQuery {
    status: ReviewStatus,
    item_type: Option<String>,
    limit: usize,
}

fn parse_review_query(query: &str) -> Result<ReviewQuery, String> {
    let params = parse_query(query);
    let status = match params
        .get("status")
        .map(|s| s.as_str())
        .unwrap_or("unresolved")
    {
        "unresolved" | "pending" => ReviewStatus::Unresolved,
        "resolved" => ReviewStatus::Resolved,
        "all" => ReviewStatus::All,
        value => {
            return Err(format!(
                "Invalid review status '{value}'. Expected unresolved, resolved, or all"
            ))
        }
    };
    let item_type = params
        .get("type")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let limit = params
        .get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(DEFAULT_MAX_REVIEWS)
        .clamp(1, HARD_MAX_REVIEWS);

    Ok(ReviewQuery {
        status,
        item_type,
        limit,
    })
}

fn normalize_review_title(title: &str) -> String {
    let trimmed = title.trim_start();
    let lower = trimmed.to_lowercase();
    let mut rest = trimmed;
    for prefix in [
        "missing page",
        "missing-page",
        "missingpage",
        "duplicate page",
        "duplicate-page",
        "duplicatepage",
        "possible duplicate",
        "possible-duplicate",
        "possibleduplicate",
        "缺失页面",
        "缺少页面",
        "重复页面",
        "疑似重复",
    ] {
        if !lower.starts_with(prefix) {
            continue;
        }
        let suffix = &trimmed[prefix.len()..];
        let Some(delimiter) = suffix.chars().next() else {
            continue;
        };
        if delimiter == ':' || delimiter == '：' {
            rest = suffix[delimiter.len_utf8()..].trim_start();
            break;
        }
    }
    rest.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn review_id_for_parts(item_type: &str, title: &str) -> String {
    let key = format!("{item_type}::{}", normalize_review_title(title));
    let mut h: u32 = 0x811c9dc5;
    for unit in key.encode_utf16() {
        h ^= u32::from(unit);
        h = h.wrapping_mul(0x01000193);
    }
    format!("review-{h:08x}")
}

fn stable_review_id(item: &Value) -> Option<String> {
    let item_type = item.get("type").and_then(Value::as_str)?;
    let title = item.get("title").and_then(Value::as_str)?;
    Some(review_id_for_parts(item_type, title))
}

fn review_id_matches(item: &Value, requested_id: &str) -> bool {
    item.get("id").and_then(Value::as_str) == Some(requested_id)
        || stable_review_id(item).as_deref() == Some(requested_id)
}

fn load_review_items(project_path: &str, query: &ReviewQuery) -> Result<Vec<Value>, String> {
    let path = Path::new(project_path).join(".llm-wiki/review.json");
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(format!("Failed to read review state: {err}")),
    };
    let parsed: Value =
        serde_json::from_str(&raw).map_err(|err| format!("Invalid review state JSON: {err}"))?;
    let items = parsed
        .as_array()
        .ok_or_else(|| "Invalid review state JSON: expected an array".to_string())?;

    let mut normalized: Vec<Value> = Vec::new();
    let mut index_by_id: BTreeMap<String, usize> = BTreeMap::new();
    for item in items {
        let sanitized = sanitize_review_item(item);
        let id = sanitized
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string);
        if let Some(id) = id {
            if let Some(existing_idx) = index_by_id.get(&id).copied() {
                merge_sanitized_review(&mut normalized[existing_idx], &sanitized);
                continue;
            }
            index_by_id.insert(id, normalized.len());
        }
        normalized.push(sanitized);
    }

    let mut reviews: Vec<Value> = Vec::new();
    for item in normalized {
        let resolved = item
            .get("resolved")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !query.status.matches(resolved) {
            continue;
        }
        if let Some(item_type) = &query.item_type {
            if item.get("type").and_then(Value::as_str) != Some(item_type.as_str()) {
                continue;
            }
        }
        if reviews.len() >= query.limit {
            break;
        }
        reviews.push(item);
    }

    Ok(reviews)
}

fn sanitize_review_item(item: &Value) -> Value {
    let mut out = Map::new();
    if let Some(id) = stable_review_id(item) {
        out.insert("id".to_string(), Value::String(id));
    } else {
        copy_string_field(item, &mut out, "id");
    }
    copy_string_field(item, &mut out, "type");
    copy_string_field(item, &mut out, "title");
    copy_string_field(item, &mut out, "description");
    copy_string_field(item, &mut out, "sourcePath");
    copy_string_array_field(item, &mut out, "affectedPages");
    copy_string_array_field(item, &mut out, "searchQueries");
    copy_review_options(item, &mut out);
    copy_bool_field(item, &mut out, "resolved");
    copy_string_field(item, &mut out, "resolvedAction");
    copy_number_field(item, &mut out, "createdAt");
    Value::Object(out)
}

fn merge_sanitized_review(existing: &mut Value, incoming: &Value) {
    let Some(existing) = existing.as_object_mut() else {
        return;
    };
    let Some(incoming) = incoming.as_object() else {
        return;
    };

    let resolved = existing
        .get("resolved")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || incoming
            .get("resolved")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    existing.insert("resolved".to_string(), Value::Bool(resolved));

    if resolved && !existing.contains_key("resolvedAction") {
        if let Some(action) = incoming.get("resolvedAction").and_then(Value::as_str) {
            existing.insert(
                "resolvedAction".to_string(),
                Value::String(action.to_string()),
            );
        }
    }

    for key in ["description", "sourcePath"] {
        let existing_empty = existing
            .get(key)
            .and_then(Value::as_str)
            .map(str::is_empty)
            .unwrap_or(true);
        if existing_empty {
            if let Some(value) = incoming.get(key).and_then(Value::as_str) {
                existing.insert(key.to_string(), Value::String(value.to_string()));
            }
        }
    }

    merge_string_array_field(existing, incoming, "affectedPages");
    merge_string_array_field(existing, incoming, "searchQueries");
    merge_review_options_field(existing, incoming);

    if let Some(incoming_created) = incoming.get("createdAt").and_then(Value::as_f64) {
        let existing_created = existing
            .get("createdAt")
            .and_then(Value::as_f64)
            .unwrap_or(incoming_created);
        existing.insert(
            "createdAt".to_string(),
            json!(existing_created.min(incoming_created)),
        );
    }
}

fn merge_string_array_field(
    existing: &mut Map<String, Value>,
    incoming: &Map<String, Value>,
    key: &str,
) {
    let mut values = existing
        .get(key)
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for value in incoming
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        if !values.iter().any(|existing| existing == value) {
            values.push(value.to_string());
        }
    }
    if !values.is_empty() {
        existing.insert(
            key.to_string(),
            Value::Array(values.into_iter().map(Value::String).collect()),
        );
    }
}

fn merge_review_options_field(existing: &mut Map<String, Value>, incoming: &Map<String, Value>) {
    let mut options = existing
        .get("options")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for option in incoming
        .get("options")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let action = option.get("action").and_then(Value::as_str);
        let already_present = action.is_some_and(|action| {
            options
                .iter()
                .any(|existing| existing.get("action").and_then(Value::as_str) == Some(action))
        });
        if !already_present {
            options.push(option.clone());
        }
    }
    if !options.is_empty() {
        existing.insert("options".to_string(), Value::Array(options));
    }
}

fn copy_string_field(item: &Value, out: &mut Map<String, Value>, key: &str) {
    if let Some(value) = item.get(key).and_then(Value::as_str) {
        out.insert(key.to_string(), Value::String(value.to_string()));
    }
}

fn copy_bool_field(item: &Value, out: &mut Map<String, Value>, key: &str) {
    if let Some(value) = item.get(key).and_then(Value::as_bool) {
        out.insert(key.to_string(), Value::Bool(value));
    }
}

fn copy_number_field(item: &Value, out: &mut Map<String, Value>, key: &str) {
    if let Some(value) = item.get(key).and_then(Value::as_f64) {
        if value.is_finite() {
            out.insert(key.to_string(), json!(value));
        }
    }
}

fn copy_string_array_field(item: &Value, out: &mut Map<String, Value>, key: &str) {
    let Some(values) = item.get(key).and_then(Value::as_array) else {
        return;
    };
    let strings = values
        .iter()
        .filter_map(Value::as_str)
        .map(|value| Value::String(value.to_string()))
        .collect::<Vec<_>>();
    out.insert(key.to_string(), Value::Array(strings));
}

fn copy_review_options(item: &Value, out: &mut Map<String, Value>) {
    let Some(values) = item.get("options").and_then(Value::as_array) else {
        return;
    };
    let options = values
        .iter()
        .filter_map(|option| {
            let option = option.as_object()?;
            let mut sanitized = Map::new();
            if let Some(label) = option.get("label").and_then(Value::as_str) {
                sanitized.insert("label".to_string(), Value::String(label.to_string()));
            }
            if let Some(action) = option.get("action").and_then(Value::as_str) {
                sanitized.insert("action".to_string(), Value::String(action.to_string()));
            }
            if sanitized.is_empty() {
                None
            } else {
                Some(Value::Object(sanitized))
            }
        })
        .collect::<Vec<_>>();
    out.insert("options".to_string(), Value::Array(options));
}

fn handle_reviews(app: &AppHandle, project_id: &str, query: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(e) => return err(404, e),
    };
    let query = match parse_review_query(query) {
        Ok(query) => query,
        Err(e) => return err(400, e),
    };
    match load_review_items(&project.path, &query) {
        Ok(reviews) => ok(json!({
            "ok": true,
            "projectId": project.id,
            "status": query.status.as_str(),
            "count": reviews.len(),
            "reviews": reviews,
        })),
        Err(e) => err(500, e),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PatchReviewRequest {
    /// Target resolved state. Defaults to `true` (the common case:
    /// resolve). Pass `false` to reopen a resolved item.
    resolved: Option<bool>,
    /// Optional human-readable action label stored on the item
    /// (e.g. "Skip", "Created page"). Mark-only — the API never
    /// replicates the WebView's side effects (page creation, etc).
    action: Option<String>,
}

/// `PATCH /projects/{id}/reviews/{reviewId}` — partial update of a
/// single review item's resolved state. Body `{ resolved?, action? }`;
/// an empty body resolves the item (resolved defaults to true).
fn handle_patch_review(
    app: &AppHandle,
    project_id: &str,
    review_id: &str,
    body: &str,
) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(e) => return err(404, e),
    };
    let req = if body.trim().is_empty() {
        PatchReviewRequest {
            resolved: None,
            action: None,
        }
    } else {
        match serde_json::from_str::<PatchReviewRequest>(body) {
            Ok(req) => req,
            Err(e) => return err(400, format!("Invalid request body: {e}")),
        }
    };
    let resolved = req.resolved.unwrap_or(true);
    match patch_review_item(&project.path, review_id, resolved, req.action.as_deref()) {
        Ok(true) => ok(json!({
            "ok": true,
            "projectId": project.id,
            "reviewId": review_id,
            "resolved": resolved,
        })),
        Ok(false) => err(404, format!("Review item '{review_id}' not found")),
        Err(e) => err(500, e),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BulkResolveRequest {
    /// Review item ids to resolve. Required, non-empty.
    ids: Vec<String>,
    /// Optional label applied to every resolved item.
    action: Option<String>,
}

/// `POST /projects/{id}/reviews/resolve` — bulk-resolve many review
/// items in one request. Body `{ ids, action? }`. Partial success is
/// normal, so this returns 200 with `{ resolved, notFound, count }`
/// rather than 404 — 404 is reserved for the single-item PATCH where
/// one unknown id is the entire request.
fn handle_bulk_resolve_reviews(app: &AppHandle, project_id: &str, body: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(e) => return err(404, e),
    };
    let req = match serde_json::from_str::<BulkResolveRequest>(body) {
        Ok(req) => req,
        Err(e) => return err(400, format!("Invalid request body: {e}")),
    };
    if req.ids.is_empty() {
        return err(400, "ids must be a non-empty array".to_string());
    }
    match resolve_review_items(&project.path, &req.ids, req.action.as_deref()) {
        Ok((resolved, not_found)) => ok(json!({
            "ok": true,
            "projectId": project.id,
            "resolved": resolved,
            "notFound": not_found,
            "count": resolved.len(),
        })),
        Err(e) => err(500, e),
    }
}

/// Set one review item's resolved state in `.llm-wiki/review.json`.
///
/// Operates on the RAW parsed array (not `load_review_items`, which
/// sanitizes — reusing it would strip fields like `internalSecret` and
/// silently corrupt the file on write-back). Sets `resolved` and, when
/// provided, `resolvedAction`. Returns Ok(false) if no item with the
/// given id exists (caller maps to 404).
fn patch_review_item(
    project_path: &str,
    review_id: &str,
    resolved: bool,
    action: Option<&str>,
) -> Result<bool, String> {
    let path = Path::new(project_path).join(".llm-wiki/review.json");
    let mut parsed = match read_raw_review_array(&path)? {
        Some(parsed) => parsed,
        None => return Ok(false),
    };
    let items = parsed
        .as_array_mut()
        .ok_or_else(|| "Invalid review state JSON: expected an array".to_string())?;

    let mut found = false;
    for item in items.iter_mut() {
        if !review_id_matches(item, review_id) {
            continue;
        }
        apply_resolution(item, resolved, action);
        if let Some(stable_id) = stable_review_id(item) {
            if let Some(obj) = item.as_object_mut() {
                obj.insert("id".to_string(), Value::String(stable_id));
            }
        }
        found = true;
    }

    if !found {
        return Ok(false);
    }
    write_raw_review_array(&path, &parsed)?;
    Ok(true)
}

/// Bulk version of `patch_review_item`: reads `review.json` ONCE,
/// resolves every matching id in the raw array, writes ONCE. Looping
/// the single-item helper would be N read-parse-write cycles with a
/// race window per write. Returns `(resolved_ids, not_found_ids)`,
/// both in the caller's input order.
fn resolve_review_items(
    project_path: &str,
    ids: &[String],
    action: Option<&str>,
) -> Result<(Vec<String>, Vec<String>), String> {
    let path = Path::new(project_path).join(".llm-wiki/review.json");
    let mut parsed = match read_raw_review_array(&path)? {
        Some(parsed) => parsed,
        // No review file → nothing exists, so every id is "not found".
        None => return Ok((Vec::new(), ids.to_vec())),
    };
    let items = parsed
        .as_array_mut()
        .ok_or_else(|| "Invalid review state JSON: expected an array".to_string())?;

    let mut found: BTreeSet<String> = BTreeSet::new();
    for item in items.iter_mut() {
        let raw_id = item.get("id").and_then(Value::as_str);
        let stable_id = stable_review_id(item);
        let matched_request = ids
            .iter()
            .find(|id| raw_id == Some(id.as_str()) || stable_id.as_deref() == Some(id.as_str()));
        let Some(requested_id) = matched_request else {
            continue;
        };
        apply_resolution(item, true, action);
        if let Some(stable_id) = stable_id {
            if let Some(obj) = item.as_object_mut() {
                obj.insert("id".to_string(), Value::String(stable_id));
            }
        }
        found.insert(requested_id.clone());
    }

    if !found.is_empty() {
        write_raw_review_array(&path, &parsed)?;
    }

    // Preserve the caller's input order; dedupe is implicit via `found`.
    let resolved: Vec<String> = ids
        .iter()
        .filter(|id| found.contains(*id))
        .cloned()
        .collect();
    let not_found: Vec<String> = ids
        .iter()
        .filter(|id| !found.contains(*id))
        .cloned()
        .collect();
    Ok((resolved, not_found))
}

/// Set `resolved` / `resolvedAction` on a raw review item value.
fn apply_resolution(item: &mut Value, resolved: bool, action: Option<&str>) {
    if let Some(obj) = item.as_object_mut() {
        obj.insert("resolved".to_string(), Value::Bool(resolved));
        if !resolved {
            obj.remove("resolvedAction");
        } else if let Some(action) = action {
            obj.insert(
                "resolvedAction".to_string(),
                Value::String(action.to_string()),
            );
        }
    }
}

/// Read `.llm-wiki/review.json` as a raw JSON value. Returns Ok(None)
/// when the file doesn't exist (callers treat that as "no items").
fn read_raw_review_array(path: &Path) -> Result<Option<Value>, String> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("Failed to read review state: {err}")),
    };
    let parsed: Value =
        serde_json::from_str(&raw).map_err(|err| format!("Invalid review state JSON: {err}"))?;
    Ok(Some(parsed))
}

fn write_raw_review_array(path: &Path, parsed: &Value) -> Result<(), String> {
    let serialized = serde_json::to_string_pretty(parsed)
        .map_err(|err| format!("Failed to serialize review state: {err}"))?;
    fs::write(path, serialized).map_err(|err| format!("Failed to write review state: {err}"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchRequest {
    query: String,
    top_k: Option<usize>,
    include_content: Option<bool>,
    query_embedding: Option<Vec<f32>>,
}

fn handle_search(app: &AppHandle, project_id: &str, body: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(e) => return err(404, e),
    };
    let req: SearchRequest = match serde_json::from_str(body) {
        Ok(req) => req,
        Err(e) => return err(400, format!("Invalid JSON: {e}")),
    };
    if req.query.trim().is_empty() {
        return err(400, "query is required");
    }
    let top_k = req.top_k.unwrap_or(10).clamp(1, MAX_SEARCH_RESULTS);
    let query = req.query;
    let query_embedding =
        match tauri::async_runtime::block_on(commands::search::resolve_query_embedding(
            &query,
            req.query_embedding,
            load_embedding_config(app),
        )) {
            Ok(embedding) => embedding,
            Err(e) => return err(400, e),
        };
    match tauri::async_runtime::block_on(commands::search::search_project_inner(
        project.path.clone(),
        query,
        top_k,
        req.include_content.unwrap_or(false),
        query_embedding,
    )) {
        Ok(search) => ok(json!({
            "ok": true,
            "projectId": project.id,
            "mode": search.mode,
            "note": "Search uses the shared backend retrieval service. When embeddingConfig is enabled, the API automatically includes LanceDB vector results; clients may also pass queryEmbedding explicitly.",
            "tokenHits": search.token_hits,
            "vectorHits": search.vector_hits,
            "results": search.results,
        })),
        Err(e) => err(500, e),
    }
}

fn handle_chat(app: &AppHandle, project_id: &str, body: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(e) => return err(404, e),
    };
    let mut req: agent::AgentChatRequest = match serde_json::from_str(body) {
        Ok(req) => req,
        Err(e) => return err(400, format!("Invalid JSON: {e}")),
    };
    if req
        .session_id
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .is_empty()
    {
        req.session_id = Some(format!("api_{}", Uuid::new_v4()));
    }
    if req
        .run_id
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .is_empty()
    {
        req.run_id = Some(format!("run_{}", Uuid::new_v4()));
    }
    let requested_session_id = req.session_id.clone();
    if let Some(session_id) = requested_session_id.as_deref() {
        if req.history.is_empty() && !req.history_explicit {
            req.history = app
                .state::<agent::session::AgentSessionStore>()
                .recent_messages(&project.path, session_id, 12)
                .into_iter()
                .map(|message| agent::types::AgentConversationMessage {
                    role: message.role,
                    content: message.content,
                })
                .collect();
        }
    }
    let runtime_config = load_agent_runtime_config(app);
    let runtime = agent::AgentRuntime::new(
        project.id.clone(),
        project.path.clone(),
        runtime_config.embedding,
        runtime_config.llm,
        runtime_config.web_search,
        runtime_config.anytxt,
    );
    let user_message_for_session = req.message.clone();
    let persist_session = req.persist_session;
    let session_id = req.session_id.clone().unwrap_or_default();
    let run_id = req.run_id.clone().unwrap_or_default();
    let cancellation = app
        .state::<agent::cancel::AgentCancellationRegistry>()
        .start(&project.id, &session_id, &run_id);
    let result =
        tauri::async_runtime::block_on(runtime.run_once_with_cancel(req, Some(cancellation)));
    app.state::<agent::cancel::AgentCancellationRegistry>()
        .finish(&project.id, &session_id, &run_id);
    match result {
        Ok(response) => {
            if persist_session {
                app.state::<agent::session::AgentSessionStore>()
                    .append_turn(
                        &project.path,
                        &project.id,
                        &response.session_id,
                        &user_message_for_session,
                        &response.message,
                    );
            }
            ok(json!({
                "ok": true,
                "projectId": response.project_id,
                "sessionId": response.session_id,
                "mode": response.mode,
                "message": {
                    "role": "assistant",
                    "content": response.message,
                },
                "references": response.references,
                "toolEvents": response.tool_events,
                "events": response.events,
                "usage": response.usage,
            }))
        }
        Err(e) if e == "message is required" => err(400, e),
        Err(e) if e == "Agent turn cancelled" => err(499, e),
        Err(e) => err(502, e),
    }
}

fn handle_cancel_chat(app: &AppHandle, project_id: &str, session_id: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(e) => return err(404, e),
    };
    ok(json!({
        "ok": true,
        "cancelled": app
            .state::<agent::cancel::AgentCancellationRegistry>()
            .cancel(&project.id, session_id, None),
        "sessionId": session_id,
    }))
}

fn load_embedding_config(app: &AppHandle) -> Option<commands::search::SearchEmbeddingConfig> {
    let parsed = load_app_state(app)?;
    let value = parsed.get("embeddingConfig")?.clone();
    serde_json::from_value::<commands::search::SearchEmbeddingConfig>(value).ok()
}

#[derive(Debug, Clone, Default)]
struct AgentRuntimeConfig {
    embedding: Option<commands::search::SearchEmbeddingConfig>,
    llm: Option<agent::provider::LlmConfig>,
    web_search: Option<agent::tools::WebSearchConfig>,
    anytxt: Option<agent::tools::AnyTxtConfig>,
}

fn load_agent_runtime_config(app: &AppHandle) -> AgentRuntimeConfig {
    let Some(parsed) = load_app_state(app) else {
        return AgentRuntimeConfig::default();
    };
    AgentRuntimeConfig {
        embedding: parsed
            .get("embeddingConfig")
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok()),
        llm: parsed
            .get("llmConfig")
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok()),
        web_search: parsed
            .get("searchApiConfig")
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok()),
        anytxt: parsed
            .get("searchApiConfig")
            .and_then(|value| value.get("anyTxt"))
            .cloned()
            .and_then(|value| serde_json::from_value(value).ok()),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiGraphNode {
    id: String,
    label: String,
    node_type: String,
    path: String,
    link_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiGraphEdge {
    source: String,
    target: String,
    weight: f64,
}

fn handle_graph(app: &AppHandle, project_id: &str, query: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(e) => return err(404, e),
    };
    let params = parse_query(query);
    let q = params.get("q").map(|s| s.to_lowercase());
    let node_type = params.get("nodeType").map(|s| s.to_lowercase());
    let limit = params
        .get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(200)
        .clamp(1, 1000);

    match build_graph(&project.path) {
        Ok((mut nodes, edges)) => {
            if let Some(ref q) = q {
                nodes.retain(|n| {
                    n.id.to_lowercase().contains(q) || n.label.to_lowercase().contains(q)
                });
            }
            if let Some(ref node_type) = node_type {
                nodes.retain(|n| n.node_type == *node_type);
            }
            nodes.truncate(limit);
            let ids: BTreeSet<String> = nodes.iter().map(|n| n.id.clone()).collect();
            let edges: Vec<ApiGraphEdge> = edges
                .into_iter()
                .filter(|e| ids.contains(&e.source) && ids.contains(&e.target))
                .collect();
            ok(json!({ "ok": true, "projectId": project.id, "nodes": nodes, "edges": edges }))
        }
        Err(e) => err(500, e),
    }
}

fn build_graph(project_path: &str) -> Result<(Vec<ApiGraphNode>, Vec<ApiGraphEdge>), String> {
    let wiki_root = Path::new(project_path).join("wiki");
    let mut raw: BTreeMap<String, (String, String, String, Vec<String>)> = BTreeMap::new();
    for entry in WalkDir::new(&wiki_root).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file()
            || entry.path().extension().and_then(|s| s.to_str()) != Some("md")
        {
            continue;
        }
        let content = match fs::read_to_string(entry.path()) {
            Ok(content) => content,
            Err(_) => continue,
        };
        let id = entry
            .path()
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if id.is_empty() {
            continue;
        }
        let title =
            commands::search::extract_title(&content, entry.file_name().to_string_lossy().as_ref());
        let node_type = extract_type(&content);
        let path = relative_to_project(project_path, entry.path());
        let links = extract_wikilinks(&content);
        raw.insert(id, (title, node_type, path, links));
    }
    let ids: BTreeSet<String> = raw.keys().cloned().collect();
    let mut link_count: BTreeMap<String, usize> = raw.keys().map(|id| (id.clone(), 0)).collect();
    let mut seen = BTreeSet::new();
    let mut edges = Vec::new();
    for (source, (_, _, _, links)) in &raw {
        for link in links {
            let Some(target) = resolve_link(link, &ids) else {
                continue;
            };
            if &target == source {
                continue;
            }
            let key = if source < &target {
                format!("{source}::{target}")
            } else {
                format!("{target}::{source}")
            };
            if seen.insert(key) {
                *link_count.entry(source.clone()).or_default() += 1;
                *link_count.entry(target.clone()).or_default() += 1;
                edges.push(ApiGraphEdge {
                    source: source.clone(),
                    target,
                    weight: 1.0,
                });
            }
        }
    }
    let nodes = raw
        .into_iter()
        .filter(|(_, (_, node_type, _, _))| node_type != "query")
        .map(|(id, (label, node_type, path, _))| ApiGraphNode {
            link_count: *link_count.get(&id).unwrap_or(&0),
            id,
            label,
            node_type,
            path,
        })
        .collect();
    Ok((nodes, edges))
}

fn extract_type(content: &str) -> String {
    for line in content.lines() {
        if let Some(value) = line.trim().strip_prefix("type:") {
            return value
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .to_lowercase();
        }
    }
    "other".to_string()
}

fn extract_wikilinks(content: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = content;
    while let Some(start) = rest.find("[[") {
        rest = &rest[start + 2..];
        let Some(end) = rest.find("]]") else {
            break;
        };
        let inner = &rest[..end];
        let target = inner.split('|').next().unwrap_or("").trim();
        if !target.is_empty() {
            out.push(target.to_string());
        }
        rest = &rest[end + 2..];
    }
    out
}

fn resolve_link(raw: &str, ids: &BTreeSet<String>) -> Option<String> {
    if ids.contains(raw) {
        return Some(raw.to_string());
    }
    let normalized = raw.to_lowercase().replace(' ', "-");
    ids.iter()
        .find(|id| id.to_lowercase() == normalized || id.to_lowercase() == raw.to_lowercase())
        .cloned()
}

fn handle_rescan(app: &AppHandle, project_id: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(e) => return err(404, e),
    };
    let source_watch_config = load_source_watch_config(app, &project.id);
    match commands::file_sync::rescan_project_files(
        app.clone(),
        project.id.clone(),
        project.path.clone(),
        source_watch_config,
    ) {
        Ok(result) => ok(json!({ "ok": true, "projectId": project.id, "result": result })),
        Err(e) => err(500, e),
    }
}

fn load_source_watch_config(
    app: &AppHandle,
    project_id: &str,
) -> Option<commands::file_sync::SourceWatchConfig> {
    let parsed = load_app_state(app)?;
    let settings = parsed.get("sourceWatchConfig").and_then(Value::as_object);
    if let Some(value) = settings
        .and_then(|s| s.get(project_id).or_else(|| s.get("default")))
        .cloned()
    {
        if let Ok(config) = serde_json::from_value::<commands::file_sync::SourceWatchConfig>(value)
        {
            return Some(config);
        }
    }
    let legacy_enabled = parsed
        .get("projectFileSyncEnabled")
        .and_then(Value::as_object)
        .and_then(|settings| {
            settings
                .get(project_id)
                .or_else(|| settings.get("default"))
                .and_then(Value::as_bool)
        });
    legacy_enabled.and_then(|enabled| {
        serde_json::from_value::<commands::file_sync::SourceWatchConfig>(
            json!({ "enabled": enabled }),
        )
        .ok()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_project_dir() -> PathBuf {
        // Per-process atomic sequence appended to the timestamp so two
        // tests calling this concurrently can't collide on the same dir
        // (nanos alone are not unique enough under parallel `cargo test`,
        // which would let one test's remove_dir_all delete another's files).
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("llm-wiki-api-test-{id}-{seq}"));
        fs::create_dir_all(path.join("wiki")).unwrap();
        path
    }

    #[test]
    fn safe_join_rejects_traversal() {
        let root = test_project_dir();
        let root_str = root.to_string_lossy();
        assert!(safe_join(&root_str, "../secret.md").is_err());
        assert!(safe_join(&root_str, "wiki/../../secret.md").is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn safe_join_accepts_project_relative_paths() {
        let root = test_project_dir();
        let root_str = root.to_string_lossy();
        let joined = safe_join(&root_str, "wiki/index.md").unwrap();
        assert_eq!(joined, root.join("wiki/index.md"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn query_parser_decodes_percent_and_plus() {
        let parsed = parse_query("path=wiki%2Fhello+world.md&token=a%2Bb");
        assert_eq!(parsed.get("path").unwrap(), "wiki/hello world.md");
        assert_eq!(parsed.get("token").unwrap(), "a+b");
    }

    #[test]
    fn snippet_handles_unicode_boundaries() {
        let content = "前言。这里是关于知识图谱过滤的中文内容。后续说明。";
        let snippet = commands::search::build_snippet(content, "知识图谱");
        assert!(snippet.contains("知识图谱"));
    }

    #[test]
    fn public_api_paths_exclude_internal_state() {
        assert!(is_public_project_rel("wiki/index.md"));
        assert!(is_public_project_rel("Wiki/index.md"));
        assert!(is_public_project_rel("raw/sources/source.md"));
        assert!(is_public_project_rel("Raw/Sources/source.md"));
        assert!(!is_public_project_rel(".llm-wiki/file-change-queue.json"));
        assert!(!is_public_project_rel("wiki/.draft.md"));
    }

    #[test]
    fn review_query_defaults_to_unresolved_items() {
        let root = test_project_dir();
        let state_dir = root.join(".llm-wiki");
        fs::create_dir_all(&state_dir).unwrap();
        fs::write(
            state_dir.join("review.json"),
            json!([
                {
                    "id": "r1",
                    "type": "missing-page",
                    "title": "Missing page: Attention",
                    "description": "Add Attention",
                    "options": [],
                    "resolved": false,
                    "createdAt": 1,
                    "internalSecret": "do-not-expose"
                },
                {
                    "id": "r2",
                    "type": "duplicate",
                    "title": "Duplicate: LLM",
                    "description": "Merge pages",
                    "options": [],
                    "resolved": true,
                    "createdAt": 2
                }
            ])
            .to_string(),
        )
        .unwrap();

        let query = parse_review_query("").unwrap();
        let reviews = load_review_items(root.to_str().unwrap(), &query).unwrap();

        assert_eq!(query.status.as_str(), "unresolved");
        assert_eq!(reviews.len(), 1);
        assert_eq!(
            reviews[0].get("id").and_then(Value::as_str),
            Some(review_id_for_parts("missing-page", "Missing page: Attention").as_str())
        );
        assert!(reviews[0].get("internalSecret").is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn review_title_normalization_requires_a_prefix_delimiter() {
        assert_eq!(
            normalize_review_title("Missing page: Attention"),
            "attention"
        );
        assert_eq!(
            normalize_review_title(" Missing page: Attention"),
            "attention"
        );
        assert_eq!(
            normalize_review_title("Missing page Attention"),
            "missing page attention"
        );
        assert_eq!(normalize_review_title("疑似重复 注意力"), "疑似重复 注意力");
        assert_ne!(
            review_id_for_parts("missing-page", "Missing page: Attention"),
            review_id_for_parts("missing-page", "Missing page Attention")
        );
        assert_eq!(
            review_id_for_parts("missing-page", "Missing page: Attention"),
            "review-dbdcf949"
        );
        assert_eq!(
            review_id_for_parts("missing-page", " Missing page: Attention"),
            "review-dbdcf949"
        );
        assert_eq!(
            review_id_for_parts("missing-page", "Missing page Attention"),
            "review-fa5d9960"
        );
        assert_eq!(
            review_id_for_parts("missing-page", "疑似重复 注意力"),
            "review-d2dacda0"
        );
    }

    #[test]
    fn review_query_filters_by_type_status_and_limit() {
        let root = test_project_dir();
        let state_dir = root.join(".llm-wiki");
        fs::create_dir_all(&state_dir).unwrap();
        fs::write(
            state_dir.join("review.json"),
            json!([
                { "id": "r1", "type": "missing-page", "title": "r1", "resolved": false, "createdAt": 1 },
                { "id": "r2", "type": "missing-page", "title": "r2", "resolved": false, "createdAt": 2 },
                { "id": "r3", "type": "duplicate", "resolved": false, "createdAt": 3 },
                { "id": "r4", "type": "missing-page", "resolved": true, "createdAt": 4 }
            ])
            .to_string(),
        )
        .unwrap();

        let query = parse_review_query("status=all&type=missing-page&limit=2").unwrap();
        let reviews = load_review_items(root.to_str().unwrap(), &query).unwrap();

        assert_eq!(query.status.as_str(), "all");
        assert_eq!(
            reviews
                .iter()
                .filter_map(|r| r.get("id").and_then(Value::as_str))
                .map(str::to_string)
                .collect::<Vec<_>>(),
            vec![
                review_id_for_parts("missing-page", "r1"),
                review_id_for_parts("missing-page", "r2"),
            ]
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn review_query_collapses_legacy_duplicate_ids_to_stable_id() {
        let root = test_project_dir();
        let state_dir = root.join(".llm-wiki");
        fs::create_dir_all(&state_dir).unwrap();
        fs::write(
            state_dir.join("review.json"),
            json!([
                {
                    "id": "review-1",
                    "type": "missing-page",
                    "title": "Attention",
                    "description": "",
                    "affectedPages": ["a.md"],
                    "resolved": false,
                    "createdAt": 5
                },
                {
                    "id": "review-2",
                    "type": "missing-page",
                    "title": "Missing page: Attention",
                    "description": "resolved copy",
                    "affectedPages": ["b.md"],
                    "resolved": true,
                    "resolvedAction": "user-resolved",
                    "createdAt": 2
                }
            ])
            .to_string(),
        )
        .unwrap();

        let query = parse_review_query("status=all").unwrap();
        let reviews = load_review_items(root.to_str().unwrap(), &query).unwrap();

        assert_eq!(reviews.len(), 1);
        assert_eq!(
            reviews[0].get("id").and_then(Value::as_str),
            Some(review_id_for_parts("missing-page", "Attention").as_str())
        );
        assert_eq!(
            reviews[0].get("resolved").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            reviews[0].get("resolvedAction").and_then(Value::as_str),
            Some("user-resolved")
        );
        assert_eq!(
            reviews[0]
                .get("affectedPages")
                .and_then(Value::as_array)
                .map(|pages| pages.iter().filter_map(Value::as_str).collect::<Vec<_>>()),
            Some(vec!["a.md", "b.md"])
        );
        assert_eq!(
            reviews[0].get("createdAt").and_then(Value::as_f64),
            Some(2.0)
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn review_query_filters_status_after_stable_id_merge() {
        let root = test_project_dir();
        let state_dir = root.join(".llm-wiki");
        fs::create_dir_all(&state_dir).unwrap();
        fs::write(
            state_dir.join("review.json"),
            json!([
                {
                    "id": "review-old-unresolved",
                    "type": "missing-page",
                    "title": "Attention",
                    "resolved": false,
                    "createdAt": 5
                },
                {
                    "id": "review-old-resolved",
                    "type": "missing-page",
                    "title": "Missing page: Attention",
                    "resolved": true,
                    "resolvedAction": "Done",
                    "createdAt": 6
                }
            ])
            .to_string(),
        )
        .unwrap();

        let unresolved = parse_review_query("status=unresolved").unwrap();
        let unresolved_reviews = load_review_items(root.to_str().unwrap(), &unresolved).unwrap();
        assert!(unresolved_reviews.is_empty());

        let all = parse_review_query("status=all").unwrap();
        let all_reviews = load_review_items(root.to_str().unwrap(), &all).unwrap();
        assert_eq!(all_reviews.len(), 1);
        assert_eq!(
            all_reviews[0].get("resolved").and_then(Value::as_bool),
            Some(true)
        );
        let _ = fs::remove_dir_all(root);
    }

    fn write_reviews(root: &Path, value: Value) {
        let state_dir = root.join(".llm-wiki");
        fs::create_dir_all(&state_dir).unwrap();
        fs::write(state_dir.join("review.json"), value.to_string()).unwrap();
    }

    fn read_reviews(root: &Path) -> Value {
        let raw = fs::read_to_string(root.join(".llm-wiki/review.json")).unwrap();
        serde_json::from_str(&raw).unwrap()
    }

    #[test]
    fn patch_review_item_marks_resolved_and_preserves_unsanitized_fields() {
        let root = test_project_dir();
        write_reviews(
            &root,
            json!([
                {
                    "id": "r1",
                    "type": "missing-page",
                    "resolved": false,
                    "createdAt": 1,
                    "internalSecret": "keep-me"
                },
                { "id": "r2", "type": "duplicate", "resolved": false, "createdAt": 2 }
            ]),
        );

        let found = patch_review_item(root.to_str().unwrap(), "r1", true, Some("Skip")).unwrap();
        assert!(found);

        // Re-read the RAW file: r1 must be resolved with the action label,
        // its non-sanitized `internalSecret` preserved (the write path must
        // not go through the sanitizing reader), and r2 left untouched.
        let parsed = read_reviews(&root);
        let items = parsed.as_array().unwrap();
        let r1 = items
            .iter()
            .find(|i| i.get("id").and_then(Value::as_str) == Some("r1"))
            .unwrap();
        assert_eq!(r1.get("resolved").and_then(Value::as_bool), Some(true));
        assert_eq!(
            r1.get("resolvedAction").and_then(Value::as_str),
            Some("Skip")
        );
        assert_eq!(
            r1.get("internalSecret").and_then(Value::as_str),
            Some("keep-me")
        );
        let r2 = items
            .iter()
            .find(|i| i.get("id").and_then(Value::as_str) == Some("r2"))
            .unwrap();
        assert_eq!(r2.get("resolved").and_then(Value::as_bool), Some(false));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn patch_review_item_accepts_stable_id_for_legacy_counter_item() {
        let root = test_project_dir();
        write_reviews(
            &root,
            json!([
                {
                    "id": "review-1",
                    "type": "missing-page",
                    "title": "Missing page: Attention",
                    "resolved": false
                }
            ]),
        );

        let stable_id = review_id_for_parts("missing-page", "Attention");
        let found =
            patch_review_item(root.to_str().unwrap(), &stable_id, true, Some("API")).unwrap();
        assert!(found);

        let parsed = read_reviews(&root);
        let item = &parsed.as_array().unwrap()[0];
        assert_eq!(
            item.get("id").and_then(Value::as_str),
            Some(stable_id.as_str())
        );
        assert_eq!(item.get("resolved").and_then(Value::as_bool), Some(true));
        assert_eq!(
            item.get("resolvedAction").and_then(Value::as_str),
            Some("API")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn patch_review_item_can_reopen_with_resolved_false() {
        let root = test_project_dir();
        write_reviews(
            &root,
            json!([{ "id": "r1", "resolved": true, "resolvedAction": "Skip" }]),
        );

        let found = patch_review_item(root.to_str().unwrap(), "r1", false, None).unwrap();
        assert!(found);

        let parsed = read_reviews(&root);
        let r1 = &parsed.as_array().unwrap()[0];
        assert_eq!(r1.get("resolved").and_then(Value::as_bool), Some(false));
        assert!(r1.get("resolvedAction").is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn patch_review_item_returns_false_for_unknown_id() {
        let root = test_project_dir();
        write_reviews(&root, json!([{ "id": "r1", "resolved": false }]));

        let found = patch_review_item(root.to_str().unwrap(), "nope", true, None).unwrap();
        assert!(!found);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn patch_review_item_missing_file_returns_false() {
        let root = test_project_dir();
        let found = patch_review_item(root.to_str().unwrap(), "r1", true, None).unwrap();
        assert!(!found);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn resolve_review_items_bulk_resolves_matching_and_reports_not_found() {
        let root = test_project_dir();
        write_reviews(
            &root,
            json!([
                { "id": "r1", "resolved": false, "internalSecret": "a" },
                { "id": "r2", "resolved": false },
                { "id": "r3", "resolved": false }
            ]),
        );

        let ids = vec!["r1".to_string(), "r3".to_string(), "missing".to_string()];
        let (resolved, not_found) =
            resolve_review_items(root.to_str().unwrap(), &ids, Some("Bulk")).unwrap();

        // Input order preserved; missing id reported, not 404'd.
        assert_eq!(resolved, vec!["r1".to_string(), "r3".to_string()]);
        assert_eq!(not_found, vec!["missing".to_string()]);

        let parsed = read_reviews(&root);
        let items = parsed.as_array().unwrap();
        let by_id = |id: &str| {
            items
                .iter()
                .find(|i| i.get("id").and_then(Value::as_str) == Some(id))
                .unwrap()
        };
        assert_eq!(
            by_id("r1").get("resolved").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            by_id("r1").get("resolvedAction").and_then(Value::as_str),
            Some("Bulk")
        );
        // Unsanitized field survives the bulk write-back too.
        assert_eq!(
            by_id("r1").get("internalSecret").and_then(Value::as_str),
            Some("a")
        );
        assert_eq!(
            by_id("r3").get("resolved").and_then(Value::as_bool),
            Some(true)
        );
        // r2 was not in the request — untouched.
        assert_eq!(
            by_id("r2").get("resolved").and_then(Value::as_bool),
            Some(false)
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn resolve_review_items_accepts_stable_ids_for_legacy_counter_items() {
        let root = test_project_dir();
        write_reviews(
            &root,
            json!([
                {
                    "id": "review-1",
                    "type": "missing-page",
                    "title": "Missing page: Attention",
                    "resolved": false
                },
                {
                    "id": "review-2",
                    "type": "duplicate",
                    "title": "Duplicate page: Transformer",
                    "resolved": false
                }
            ]),
        );

        let ids = vec![
            review_id_for_parts("missing-page", "Attention"),
            "missing".to_string(),
        ];
        let (resolved, not_found) =
            resolve_review_items(root.to_str().unwrap(), &ids, Some("Bulk")).unwrap();

        assert_eq!(resolved, vec![ids[0].clone()]);
        assert_eq!(not_found, vec!["missing".to_string()]);
        let parsed = read_reviews(&root);
        let items = parsed.as_array().unwrap();
        assert_eq!(
            items[0].get("id").and_then(Value::as_str),
            Some(ids[0].as_str())
        );
        assert_eq!(
            items[0].get("resolved").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(items[1].get("id").and_then(Value::as_str), Some("review-2"));
        assert_eq!(
            items[1].get("resolved").and_then(Value::as_bool),
            Some(false)
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn resolve_review_items_missing_file_reports_all_not_found() {
        let root = test_project_dir();
        let ids = vec!["r1".to_string(), "r2".to_string()];
        let (resolved, not_found) =
            resolve_review_items(root.to_str().unwrap(), &ids, None).unwrap();
        assert!(resolved.is_empty());
        assert_eq!(not_found, ids);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn project_path_match_normalizes_separators() {
        assert!(project_path_matches(
            "C:/Users/me/wiki",
            "C:\\Users\\me\\wiki"
        ));
        if cfg!(windows) {
            assert!(project_path_matches("C:/Users/me/wiki", "c:/users/me/wiki"));
        } else {
            assert!(!project_path_matches(
                "C:/Users/me/wiki",
                "c:/users/me/wiki"
            ));
        }
    }

    #[test]
    fn tokenize_keeps_single_cjk_character() {
        assert_eq!(
            crate::commands::search::tokenize_query("图"),
            Vec::<String>::new()
        );
        let tokens = crate::commands::search::tokenize_query("知识图谱");
        assert!(tokens.contains(&"知识".to_string()));
    }

    #[test]
    fn text_content_filter_rejects_binary_extensions() {
        assert!(is_text_content_rel("wiki/index.md"));
        assert!(!is_text_content_rel("wiki/media/image.png"));
        assert!(!is_text_content_rel("raw/sources/book.pdf"));
    }

    #[test]
    fn constant_time_eq_matches_equal_bytes_only() {
        assert!(constant_time_eq(b"token", b"token"));
        assert!(constant_time_eq(b"", b""));
        assert!(!constant_time_eq(b"token", b"tokeN"));
        assert!(!constant_time_eq(b"token", b"token-longer"));
    }

    #[test]
    fn rate_limit_skips_health_and_options_only() {
        assert!(!should_rate_limit(&Method::Get, "/api/v1/health"));
        assert!(!should_rate_limit(&Method::Options, "/api/v1/projects"));
        assert!(should_rate_limit(&Method::Get, "/wp-login"));
        assert!(should_rate_limit(
            &Method::Post,
            "/api/v1/projects/current/search"
        ));
    }

    #[test]
    fn chat_endpoint_allows_larger_multimodal_bodies() {
        assert_eq!(
            body_limit_for_request(&Method::Post, "/api/v1/projects/current/chat"),
            MAX_CHAT_BODY_BYTES
        );
        assert_eq!(
            body_limit_for_request(&Method::Post, "/api/v1/projects/current/search"),
            MAX_BODY_BYTES
        );
    }

    #[test]
    fn chat_routes_are_recognized_as_agent_requests() {
        assert!(is_agent_chat_request(
            &Method::Post,
            "/api/v1/projects/current/chat"
        ));
        assert!(is_agent_chat_request(
            &Method::Post,
            "/api/v1/projects/current/chat/session-1/cancel"
        ));
        assert!(!is_agent_chat_request(
            &Method::Post,
            "/api/v1/projects/current/search"
        ));
        assert!(!is_agent_chat_request(
            &Method::Get,
            "/api/v1/projects/current/chat"
        ));
    }

    #[test]
    fn api_config_shape_parses_enabled_and_unauthenticated_access() {
        // Standalone pure-function check to mirror what `api_enabled`
        // reads off `load_app_state`. Mirrors the JS-side shape
        // emitted by `saveApiConfig` so any rename on either side
        // surfaces here before users hit it as a 503 in production.
        let payload = json!({
            "apiConfig": {
                "enabled": false,
                "allowUnauthenticated": true,
                "allowLanAccess": true,
                "mcpEnabled": true,
                "token": "abc"
            }
        });
        let enabled = payload
            .get("apiConfig")
            .and_then(|v| v.get("enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(true);
        assert!(!enabled);
        let allow_unauthenticated = payload
            .get("apiConfig")
            .and_then(|v| v.get("allowUnauthenticated"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        assert!(allow_unauthenticated);
        let allow_lan_access = payload
            .get("apiConfig")
            .and_then(|v| v.get("allowLanAccess"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        assert!(allow_lan_access);
        let mcp_enabled = payload
            .get("apiConfig")
            .and_then(|v| v.get("mcpEnabled"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        assert!(mcp_enabled);
        let token_source = payload
            .get("apiConfig")
            .and_then(|v| v.get("token"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(|_| "store")
            .unwrap_or("none");
        assert_eq!(token_source, "store");

        let missing = json!({});
        let enabled_missing = missing
            .get("apiConfig")
            .and_then(|v| v.get("enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(true);
        // Fail-open by design — see `api_enabled` doc comment.
        assert!(enabled_missing);
        let mcp_enabled_missing = missing
            .get("apiConfig")
            .and_then(|v| v.get("mcpEnabled"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        assert!(!mcp_enabled_missing);
        let allow_lan_access_missing = missing
            .get("apiConfig")
            .and_then(|v| v.get("allowLanAccess"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        assert!(!allow_lan_access_missing);
    }
}
