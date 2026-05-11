use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::sync::{Condvar, Mutex};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::LazyLock;
use std::thread;
use std::time::{Duration, Instant};
use tiny_http::{Header, Method, Request, Response, Server};

static CURRENT_PROJECT: Mutex<String> = Mutex::new(String::new());
static ALL_PROJECTS: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new()); // (name, path)
static PENDING_CLIPS: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new()); // (projectPath, filePath)
static API_BRIDGE_REQUESTS: Mutex<Vec<ApiBridgeRequest>> = Mutex::new(Vec::new());
static API_BRIDGE_RESPONSES: LazyLock<Mutex<HashMap<String, ApiBridgeResponse>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static API_BRIDGE_CVAR: Condvar = Condvar::new();

/// Daemon status: 0=starting, 1=running, 2=port_conflict, 3=error
static DAEMON_STATUS: AtomicU8 = AtomicU8::new(0);
static NEXT_API_REQUEST_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

const PORT: u16 = 19827;
const MAX_BIND_RETRIES: u32 = 3;
const MAX_RESTART_RETRIES: u32 = 10;
const BIND_RETRY_DELAY_SECS: u64 = 2;
const RESTART_DELAY_SECS: u64 = 5;
const API_SHORT_TIMEOUT_SECS: u64 = 60;
const API_LONG_TIMEOUT_SECS: u64 = 30 * 60;

#[derive(Clone, Serialize)]
struct ApiBridgeRequest {
    id: String,
    endpoint: String,
    payload: serde_json::Value,
}

#[derive(Clone)]
struct ApiBridgeResponse {
    ok: bool,
    payload: serde_json::Value,
}

/// Get current daemon status as a string
pub fn get_daemon_status() -> &'static str {
    match DAEMON_STATUS.load(Ordering::Relaxed) {
        0 => "starting",
        1 => "running",
        2 => "port_conflict",
        _ => "error",
    }
}

pub fn start_clip_server() {
    thread::spawn(|| {
        let mut restart_count: u32 = 0;

        loop {
            // Try to bind the port with retries
            let server = {
                let mut last_err = String::new();
                let mut bound = None;
                for attempt in 1..=MAX_BIND_RETRIES {
                    match Server::http(format!("127.0.0.1:{}", PORT)) {
                        Ok(s) => {
                            bound = Some(s);
                            break;
                        }
                        Err(e) => {
                            last_err = format!("{}", e);
                            eprintln!(
                                "[Clip Server] Bind attempt {}/{} failed: {}",
                                attempt, MAX_BIND_RETRIES, e
                            );
                            if attempt < MAX_BIND_RETRIES {
                                thread::sleep(std::time::Duration::from_secs(BIND_RETRY_DELAY_SECS));
                            }
                        }
                    }
                }
                match bound {
                    Some(s) => s,
                    None => {
                        eprintln!(
                            "[Clip Server] Port {} unavailable after {} attempts: {}",
                            PORT, MAX_BIND_RETRIES, last_err
                        );
                        DAEMON_STATUS.store(2, Ordering::Relaxed); // port_conflict
                        return; // Don't retry on port conflict — needs user action
                    }
                }
            };

            DAEMON_STATUS.store(1, Ordering::Relaxed); // running
            restart_count = 0; // Reset on successful bind
            println!("[Clip Server] Listening on http://127.0.0.1:{}", PORT);

            for request in server.incoming_requests() {
                thread::spawn(move || handle_request(request));
            }

            // Server loop exited (shouldn't happen normally)
            DAEMON_STATUS.store(3, Ordering::Relaxed); // error
            restart_count += 1;

            if restart_count >= MAX_RESTART_RETRIES {
                eprintln!(
                    "[Clip Server] Exceeded max restarts ({}). Giving up.",
                    MAX_RESTART_RETRIES
                );
                return;
            }

            eprintln!(
                "[Clip Server] Crashed. Restarting in {}s (attempt {}/{})",
                RESTART_DELAY_SECS, restart_count, MAX_RESTART_RETRIES
            );
            thread::sleep(std::time::Duration::from_secs(RESTART_DELAY_SECS));
        }
    });
}

fn cors_headers() -> Vec<Header> {
    vec![
        Header::from_bytes("Access-Control-Allow-Origin", "*").unwrap(),
        Header::from_bytes("Access-Control-Allow-Methods", "GET, POST, OPTIONS").unwrap(),
        Header::from_bytes("Access-Control-Allow-Headers", "Content-Type").unwrap(),
        Header::from_bytes("Content-Type", "application/json").unwrap(),
    ]
}

fn respond_json(request: Request, status: u16, body: serde_json::Value) {
    let mut response = Response::from_string(body.to_string()).with_status_code(status);
    for h in cors_headers() {
        response.add_header(h);
    }
    let _ = request.respond(response);
}

fn read_body(request: &mut Request) -> Result<String, String> {
    let mut body = String::new();
    request
        .as_reader()
        .read_to_string(&mut body)
        .map_err(|e| format!("Failed to read body: {e}"))?;
    Ok(body)
}

fn current_project_path() -> String {
    CURRENT_PROJECT.lock().unwrap().clone()
}

fn projects_json() -> serde_json::Value {
    let projects = ALL_PROJECTS.lock().unwrap().clone();
    let current = current_project_path();
    let items: Vec<serde_json::Value> = projects
        .iter()
        .map(|(name, path)| {
            serde_json::json!({
                "name": name,
                "path": path,
                "current": path == &current,
            })
        })
        .collect();
    serde_json::json!({
        "ok": true,
        "projects": items,
    })
}

fn api_capabilities() -> Vec<&'static str> {
    vec![
        "status",
        "search",
        "retrieve",
        "chat",
        "graph",
        "ingest.clip",
        "ingest.file",
    ]
}

fn handle_request(mut request: Request) {
    if request.method() == &Method::Options {
        let mut response = Response::from_string("").with_status_code(204);
        for h in cors_headers() {
            response.add_header(h);
        }
        let _ = request.respond(response);
        return;
    }

    let url = request.url().to_string();
    let path = url.split('?').next().unwrap_or(url.as_str());

    match (request.method(), path) {
        (&Method::Get, "/status") => {
            respond_json(request, 200, serde_json::json!({"ok": true, "version": "0.1.0"}));
        }
        (&Method::Get, "/project") => {
            respond_json(
                request,
                200,
                serde_json::json!({
                    "ok": true,
                    "path": current_project_path(),
                }),
            );
        }
        (&Method::Post, "/project") => {
            let body = match read_body(&mut request) {
                Ok(body) => body,
                Err(error) => {
                    respond_json(request, 400, serde_json::json!({"ok": false, "error": error}));
                    return;
                }
            };
            let result = handle_set_project(&body);
            let parsed = serde_json::from_str::<serde_json::Value>(&result)
                .unwrap_or_else(|_| serde_json::json!({"ok": false, "error": result}));
            let status = if parsed["ok"].as_bool().unwrap_or(false) { 200 } else { 400 };
            respond_json(request, status, parsed);
        }
        (&Method::Get, "/projects") => {
            respond_json(request, 200, projects_json());
        }
        (&Method::Post, "/projects") => {
            let body = read_body(&mut request).unwrap_or_default();
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&body) {
                if let Some(arr) = parsed["projects"].as_array() {
                    let mut projects = ALL_PROJECTS.lock().unwrap();
                    projects.clear();
                    for item in arr {
                        let name = item["name"].as_str().unwrap_or("").to_string();
                        let path = item["path"].as_str().unwrap_or("").to_string();
                        if !path.is_empty() {
                            projects.push((name, path));
                        }
                    }
                }
            }
            respond_json(request, 200, serde_json::json!({"ok": true}));
        }
        (&Method::Get, "/clips/pending") => {
            let mut pending = PENDING_CLIPS.lock().unwrap();
            let clips_json: Vec<serde_json::Value> = pending
                .iter()
                .map(|(proj, file)| {
                    serde_json::json!({
                        "projectPath": proj,
                        "filePath": file,
                    })
                })
                .collect();
            pending.clear();
            respond_json(
                request,
                200,
                serde_json::json!({
                    "ok": true,
                    "clips": clips_json,
                }),
            );
        }
        (&Method::Post, "/clip") => {
            let body = match read_body(&mut request) {
                Ok(body) => body,
                Err(error) => {
                    respond_json(request, 400, serde_json::json!({"ok": false, "error": error}));
                    return;
                }
            };
            let result = handle_clip(&body);
            let parsed = serde_json::from_str::<serde_json::Value>(&result)
                .unwrap_or_else(|_| serde_json::json!({"ok": false, "error": result}));
            let status = if parsed["ok"].as_bool().unwrap_or(false) { 200 } else { 500 };
            respond_json(request, status, parsed);
        }
        (&Method::Get, "/api/v1/status") => {
            respond_json(
                request,
                200,
                serde_json::json!({
                    "ok": true,
                    "version": "0.1.0",
                    "apiVersion": "v1",
                    "project": {
                        "path": current_project_path(),
                    },
                    "projects": projects_json()["projects"].clone(),
                    "capabilities": api_capabilities(),
                    "bridge": {
                        "mode": "frontend",
                        "pending": API_BRIDGE_REQUESTS.lock().map(|q| q.len()).unwrap_or(0),
                    },
                }),
            );
        }
        (&Method::Get, "/api/v1/bridge/pending") => {
            let requests = {
                let mut queue = API_BRIDGE_REQUESTS.lock().unwrap();
                queue.drain(..).collect::<Vec<_>>()
            };
            respond_json(
                request,
                200,
                serde_json::json!({
                    "ok": true,
                    "requests": requests,
                }),
            );
        }
        (&Method::Post, "/api/v1/bridge/respond") => {
            let body = match read_body(&mut request) {
                Ok(body) => body,
                Err(error) => {
                    respond_json(request, 400, serde_json::json!({"ok": false, "error": error}));
                    return;
                }
            };
            let parsed = match serde_json::from_str::<serde_json::Value>(&body) {
                Ok(value) => value,
                Err(e) => {
                    respond_json(
                        request,
                        400,
                        serde_json::json!({"ok": false, "error": format!("Invalid JSON: {e}")}),
                    );
                    return;
                }
            };
            let id = match parsed["id"].as_str() {
                Some(id) if !id.is_empty() => id.to_string(),
                _ => {
                    respond_json(
                        request,
                        400,
                        serde_json::json!({"ok": false, "error": "id field is required"}),
                    );
                    return;
                }
            };
            let ok = parsed["ok"].as_bool().unwrap_or(false);
            let payload = if ok {
                parsed.get("result").cloned().unwrap_or(serde_json::Value::Null)
            } else {
                parsed
                    .get("error")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!("Unknown bridge error"))
            };
            {
                let mut responses = API_BRIDGE_RESPONSES.lock().unwrap();
                responses.insert(id, ApiBridgeResponse { ok, payload });
            }
            API_BRIDGE_CVAR.notify_all();
            respond_json(request, 200, serde_json::json!({"ok": true}));
        }
        (&Method::Post, p) if p.starts_with("/api/v1/") => {
            let endpoint = p.trim_start_matches("/api/v1/").to_string();
            let body = match read_body(&mut request) {
                Ok(body) => body,
                Err(error) => {
                    respond_json(request, 400, serde_json::json!({"ok": false, "error": error}));
                    return;
                }
            };
            match forward_to_frontend_bridge(&endpoint, &body) {
                Ok(value) => respond_json(request, 200, value),
                Err((status, value)) => respond_json(request, status, value),
            }
        }
        _ => {
            respond_json(
                request,
                404,
                serde_json::json!({"ok": false, "error": "Not found"}),
            );
        }
    }
}

fn forward_to_frontend_bridge(
    endpoint: &str,
    body: &str,
) -> Result<serde_json::Value, (u16, serde_json::Value)> {
    let mut payload = if body.trim().is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str::<serde_json::Value>(body).map_err(|e| {
            (
                400,
                serde_json::json!({"ok": false, "error": format!("Invalid JSON: {e}")}),
            )
        })?
    };

    if let Some(obj) = payload.as_object_mut() {
        if !obj.contains_key("projectPath") {
            let current = current_project_path();
            if !current.is_empty() {
                obj.insert("projectPath".to_string(), serde_json::json!(current));
            }
        }
    }

    let id = NEXT_API_REQUEST_ID
        .fetch_add(1, Ordering::Relaxed)
        .to_string();
    let request = ApiBridgeRequest {
        id: id.clone(),
        endpoint: endpoint.to_string(),
        payload,
    };

    {
        let mut queue = API_BRIDGE_REQUESTS.lock().map_err(|e| {
            (
                500,
                serde_json::json!({"ok": false, "error": format!("Bridge queue lock error: {e}")}),
            )
        })?;
        queue.push(request);
    }

    let timeout_secs = if endpoint == "chat" || endpoint.starts_with("ingest/") {
        API_LONG_TIMEOUT_SECS
    } else {
        API_SHORT_TIMEOUT_SECS
    };
    let deadline = Instant::now() + Duration::from_secs(timeout_secs);
    let mut responses = API_BRIDGE_RESPONSES.lock().map_err(|e| {
        (
            500,
            serde_json::json!({"ok": false, "error": format!("Bridge response lock error: {e}")}),
        )
    })?;

    loop {
        if let Some(response) = responses.remove(&id) {
            if response.ok {
                return Ok(serde_json::json!({
                    "ok": true,
                    "result": response.payload,
                }));
            }
            return Err((
                500,
                serde_json::json!({
                    "ok": false,
                    "error": response.payload,
                }),
            ));
        }

        let now = Instant::now();
        if now >= deadline {
            return Err((
                504,
                serde_json::json!({
                    "ok": false,
                    "error": format!("Timed out waiting for frontend bridge after {timeout_secs}s"),
                }),
            ));
        }

        let remaining = deadline.saturating_duration_since(now);
        let (guard, wait_result) = API_BRIDGE_CVAR
            .wait_timeout(responses, remaining)
            .map_err(|e| {
                (
                    500,
                    serde_json::json!({"ok": false, "error": format!("Bridge wait error: {e}")}),
                )
            })?;
        responses = guard;
        if wait_result.timed_out() {
            return Err((
                504,
                serde_json::json!({
                    "ok": false,
                    "error": format!("Timed out waiting for frontend bridge after {timeout_secs}s"),
                }),
            ));
        }
    }
}

fn handle_set_project(body: &str) -> String {
    let parsed: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => return format!(r#"{{"ok":false,"error":"Invalid JSON: {}"}}"#, e),
    };

    let path = match parsed["path"].as_str() {
        // Normalize to forward slashes on ingress so downstream
        // comparisons against frontend-normalized paths succeed.
        Some(p) => p.replace('\\', "/"),
        None => return r#"{"ok":false,"error":"path field is required"}"#.to_string(),
    };

    match CURRENT_PROJECT.lock() {
        Ok(mut guard) => {
            *guard = path;
            r#"{"ok":true}"#.to_string()
        }
        Err(e) => format!(r#"{{"ok":false,"error":"Lock error: {}"}}"#, e),
    }
}

fn handle_clip(body: &str) -> String {
    let parsed: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => return format!(r#"{{"ok":false,"error":"Invalid JSON: {}"}}"#, e),
    };

    let title = parsed["title"].as_str().unwrap_or("Untitled");
    let url = parsed["url"].as_str().unwrap_or("");
    let content = parsed["content"].as_str().unwrap_or("");

    // Use projectPath from request body, or fall back to globally-set project path
    let project_path_from_body = parsed["projectPath"].as_str().unwrap_or("").to_string();
    let project_path = if project_path_from_body.is_empty() {
        match CURRENT_PROJECT.lock() {
            Ok(guard) => guard.clone(),
            Err(e) => return format!(r#"{{"ok":false,"error":"Lock error: {}"}}"#, e),
        }
    } else {
        project_path_from_body
    };
    // Normalize to forward slashes so string comparisons against the
    // frontend-side project path (already normalized) succeed on Windows.
    let project_path = project_path.replace('\\', "/");

    if project_path.is_empty() {
        return r#"{"ok":false,"error":"projectPath is required (set via POST /project or include in request body)"}"#
            .to_string();
    }

    if content.is_empty() {
        return r#"{"ok":false,"error":"content is required"}"#.to_string();
    }

    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    let date_compact = chrono::Local::now().format("%Y%m%d").to_string();

    // Generate slug from title
    let slug_raw: String = title
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == ' ' || c == '-' {
                c
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
        .to_lowercase();
    let slug: String = slug_raw.chars().take(50).collect();

    let base_name = format!("{}-{}", slug, date_compact);
    // Use PathBuf for cross-platform path construction
    let dir_path = std::path::Path::new(&project_path).join("raw").join("sources");

    // Ensure directory exists
    if let Err(e) = std::fs::create_dir_all(&dir_path) {
        return format!(
            r#"{{"ok":false,"error":"Failed to create directory: {}"}}"#,
            e
        );
    }

    // Find unique filename
    let mut file_path = dir_path.join(format!("{}.md", base_name));
    let mut counter = 2u32;
    while file_path.exists() {
        file_path = dir_path.join(format!("{}-{}.md", base_name, counter));
        counter += 1;
    }
    // Normalize to forward slashes so the string compares cleanly against
    // frontend-side project paths (already normalized) and survives JSON
    // serialization (the hand-rolled serializer below doesn't escape
    // backslashes; a Windows path like `...\raw\sources\foo.md` would
    // produce invalid JSON escape sequences for `\r` / `\s` / etc).
    let file_path = file_path.to_string_lossy().replace('\\', "/");

    // Build markdown content with web-clip origin
    let markdown = format!(
        "---\ntype: clip\ntitle: \"{}\"\nurl: \"{}\"\nclipped: {}\norigin: web-clip\nsources: []\ntags: [web-clip]\n---\n\n# {}\n\nSource: {}\n\n{}\n",
        title.replace('"', r#"\""#),
        url.replace('"', r#"\""#),
        date,
        title,
        url,
        content,
    );

    if let Err(e) = std::fs::write(&file_path, &markdown) {
        return format!(
            r#"{{"ok":false,"error":"Failed to write file: {}"}}"#,
            e
        );
    }

    // Compute relative path using Path for cross-platform separator handling
    let relative_path = {
        let full = std::path::Path::new(&file_path);
        let base = std::path::Path::new(&project_path);
        full.strip_prefix(base)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| file_path.replace('\\', "/"))
    };

    // Add to pending clips for frontend to pick up and auto-ingest
    if let Ok(mut pending) = PENDING_CLIPS.lock() {
        pending.push((project_path, file_path.clone()));
    }

    serde_json::json!({
        "ok": true,
        "path": relative_path,
    }).to_string()
}
