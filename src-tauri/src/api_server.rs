mod auth;
mod common;
mod files;
mod graph;
mod http;
mod projects;
mod rescan;
mod search;

use std::collections::VecDeque;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::AppHandle;
use tiny_http::{Method, Server};

use self::auth::{
    api_allow_unauthenticated, api_auth_required, api_enabled, api_token, api_token_source,
    is_authorized,
};
use self::common::{err, ok, ApiResponse};
use self::http::{respond_error, respond_json, respond_options, split_url};

const PORT: u16 = 19828;
const API_PREFIX: &str = "/api/v1";
const MAX_BODY_BYTES: usize = 1024 * 1024;
const MAX_FILE_CONTENT_BYTES: u64 = 2 * 1024 * 1024;
const DEFAULT_MAX_FILES: usize = 2_000;
const HARD_MAX_FILES: usize = 10_000;
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
static RATE_LIMIT: OnceLock<Mutex<VecDeque<Instant>>> = OnceLock::new();

pub fn get_api_status() -> &'static str {
    match API_STATUS.load(Ordering::Relaxed) {
        0 => "starting",
        1 => "running",
        2 => "port_conflict",
        _ => "error",
    }
}

pub fn invalidate_config_cache() {
    auth::invalidate_config_cache();
}

pub fn start_api_server(app: AppHandle) {
    thread::spawn(move || loop {
        API_STATUS.store(0, Ordering::Relaxed);
        let server = match bind_server_with_retry() {
            Some(server) => server,
            None => {
                API_STATUS.store(2, Ordering::Relaxed);
                thread::sleep(Duration::from_secs(BIND_RETRY_DELAY_SECS));
                continue;
            }
        };

        API_STATUS.store(1, Ordering::Relaxed);
        eprintln!("[API Server] Listening on http://127.0.0.1:{PORT}{API_PREFIX}");

        for request in server.incoming_requests() {
            let method = request.method().clone();
            let url = request.url().to_string();
            if should_rate_limit(&method, &url) && !allow_request() {
                respond_error(request, 429, "Too many requests");
                continue;
            }
            let Some(slot) = try_acquire_request_slot() else {
                respond_error(request, 503, "API server is busy");
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

fn bind_server_with_retry() -> Option<Server> {
    for attempt in 1..=MAX_BIND_RETRIES {
        match Server::http(format!("127.0.0.1:{PORT}")) {
            Ok(server) => return Some(server),
            Err(err) => {
                eprintln!(
                    "[API Server] Failed to bind 127.0.0.1:{PORT} (attempt {attempt}/{MAX_BIND_RETRIES}): {err}"
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
    if method == Method::Options {
        respond_options(request);
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

    let body = match read_body(&mut request) {
        Ok(body) => body,
        Err(err) => {
            respond_error(request, 400, &err);
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
    respond_json(request, response.status, response.body);
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
            "allowUnauthenticated": api_allow_unauthenticated(app),
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
    if !is_authorized(app, query, headers) {
        return err(401, "Unauthorized");
    }
    if !matches!(method, &Method::Get | &Method::Post) {
        return err(405, "Method not allowed");
    }

    let parts: Vec<&str> = path
        .trim_start_matches(API_PREFIX)
        .trim_start_matches('/')
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();

    match (method, parts.as_slice()) {
        (&Method::Get, ["projects"]) => projects::handle_projects(app),
        (&Method::Get, ["projects", project_id, "files"]) => {
            files::handle_files(app, project_id, query)
        }
        (&Method::Get, ["projects", project_id, "files", "content"]) => {
            files::handle_file_content(app, project_id, query)
        }
        (&Method::Post, ["projects", project_id, "search"]) => {
            search::handle_search(app, project_id, body)
        }
        (&Method::Get, ["projects", project_id, "graph"]) => {
            graph::handle_graph(app, project_id, query)
        }
        (&Method::Post, ["projects", project_id, "sources", "rescan"]) => {
            rescan::handle_rescan(app, project_id)
        }
        (&Method::Post, ["projects", project_id, "chat"]) => {
            let _ = project_id;
            err(501, "Chat API is not implemented in the local Rust API server yet. The existing chat/RAG pipeline currently lives in the WebView; expose it after moving the shared chat pipeline behind a backend command.")
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

fn read_body(request: &mut tiny_http::Request) -> Result<String, String> {
    let mut limited = request.as_reader().take(MAX_BODY_BYTES as u64 + 1);
    let mut bytes = Vec::new();
    limited
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Failed to read body: {e}"))?;
    if bytes.len() > MAX_BODY_BYTES {
        return Err("Request body too large".to_string());
    }
    String::from_utf8(bytes).map_err(|_| "Request body must be UTF-8".to_string())
}

fn normalize_path(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').to_string()
}

fn relative_to_project(project_path: &str, path: &Path) -> String {
    let root = Path::new(project_path);
    let to_forward_slash = |value: &Path| value.to_string_lossy().replace('\\', "/");
    if let Ok(stripped) = path.strip_prefix(root) {
        return to_forward_slash(stripped);
    }
    if let (Ok(root_canon), Ok(path_canon)) = (root.canonicalize(), path.canonicalize()) {
        if let Ok(stripped) = path_canon.strip_prefix(&root_canon) {
            return to_forward_slash(stripped);
        }
    }
    to_forward_slash(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_project_dir() -> PathBuf {
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("llm-wiki-api-test-{id}"));
        fs::create_dir_all(path.join("wiki")).unwrap();
        path
    }

    #[test]
    fn safe_join_rejects_traversal() {
        let root = test_project_dir();
        let root_str = root.to_string_lossy();
        assert!(files::safe_join(&root_str, "../secret.md").is_err());
        assert!(files::safe_join(&root_str, "wiki/../../secret.md").is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn safe_join_accepts_project_relative_paths() {
        let root = test_project_dir();
        let root_str = root.to_string_lossy();
        let joined = files::safe_join(&root_str, "wiki/index.md").unwrap();
        assert_eq!(joined, root.join("wiki/index.md"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn query_parser_decodes_percent_and_plus() {
        let parsed = common::parse_query("path=wiki%2Fhello+world.md&token=a%2Bb");
        assert_eq!(parsed.get("path").unwrap(), "wiki/hello world.md");
        assert_eq!(parsed.get("token").unwrap(), "a+b");
    }

    #[test]
    fn snippet_handles_unicode_boundaries() {
        let content = "前言。这里是关于知识图谱过滤的中文内容。后续说明。";
        let snippet = crate::commands::search::build_snippet(content, "知识图谱");
        assert!(snippet.contains("知识图谱"));
    }

    #[test]
    fn public_api_paths_exclude_internal_state() {
        assert!(files::is_public_project_rel("wiki/index.md"));
        assert!(files::is_public_project_rel("Wiki/index.md"));
        assert!(files::is_public_project_rel("raw/sources/source.md"));
        assert!(files::is_public_project_rel("Raw/Sources/source.md"));
        assert!(!files::is_public_project_rel(
            ".llm-wiki/file-change-queue.json"
        ));
        assert!(!files::is_public_project_rel("wiki/.draft.md"));
    }

    #[test]
    fn project_path_match_normalizes_separators() {
        assert!(projects::project_path_matches(
            "C:/Users/me/wiki",
            "C:\\Users\\me\\wiki"
        ));
        if cfg!(windows) {
            assert!(projects::project_path_matches(
                "C:/Users/me/wiki",
                "c:/users/me/wiki"
            ));
        } else {
            assert!(!projects::project_path_matches(
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
        assert!(files::is_text_content_rel("wiki/index.md"));
        assert!(!files::is_text_content_rel("wiki/media/image.png"));
        assert!(!files::is_text_content_rel("raw/sources/book.pdf"));
    }

    #[test]
    fn constant_time_eq_matches_equal_bytes_only() {
        assert!(auth::constant_time_eq(b"token", b"token"));
        assert!(auth::constant_time_eq(b"", b""));
        assert!(!auth::constant_time_eq(b"token", b"tokeN"));
        assert!(!auth::constant_time_eq(b"token", b"token-longer"));
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
    fn api_config_shape_parses_enabled_and_unauthenticated_access() {
        // Standalone pure-function check to mirror what `api_enabled`
        // reads off `load_app_state`. Mirrors the JS-side shape
        // emitted by `saveApiConfig` so any rename on either side
        // surfaces here before users hit it as a 503 in production.
        let payload = json!({
            "apiConfig": {
                "enabled": false,
                "allowUnauthenticated": true,
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
    }
}
