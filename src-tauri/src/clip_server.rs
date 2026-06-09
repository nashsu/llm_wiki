use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use tauri::AppHandle;
use tiny_http::{Header, Method, Response, Server};

use crate::{local_auth, observability};

static CURRENT_PROJECT: Mutex<String> = Mutex::new(String::new());
static ALL_PROJECTS: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());
static PENDING_CLIPS: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());
static CLIP_APP: Mutex<Option<AppHandle>> = Mutex::new(None);

static DAEMON_STATUS: AtomicU8 = AtomicU8::new(0);

const PORT: u16 = 19827;
const MAX_BIND_RETRIES: u32 = 3;
const MAX_RESTART_RETRIES: u32 = 10;
const BIND_RETRY_DELAY_SECS: u64 = 2;
const RESTART_DELAY_SECS: u64 = 5;
const MAX_BODY_BYTES: usize = 5 * 1024 * 1024;

pub fn get_daemon_status() -> &'static str {
    match DAEMON_STATUS.load(Ordering::Relaxed) {
        0 => "starting",
        1 => "running",
        2 => "port_conflict",
        _ => "error",
    }
}

pub fn current_project_path() -> String {
    CURRENT_PROJECT
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default()
}

pub fn all_projects() -> Vec<(String, String)> {
    ALL_PROJECTS
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default()
}

pub fn start_clip_server(app: AppHandle) {
    if let Ok(mut guard) = CLIP_APP.lock() {
        *guard = Some(app.clone());
    }

    thread::spawn(move || {
        let mut restart_count: u32 = 0;

        loop {
            let server = {
                let mut last_err = String::new();
                let mut bound = None;
                for attempt in 1..=MAX_BIND_RETRIES {
                    match Server::http(format!("127.0.0.1:{PORT}")) {
                        Ok(s) => {
                            bound = Some(s);
                            break;
                        }
                        Err(e) => {
                            last_err = format!("{e}");
                            observability::log_warn(
                                "clip_server",
                                "bind_failed",
                                &[
                                    ("attempt", &attempt.to_string()),
                                    ("error", &last_err),
                                ],
                            );
                            if attempt < MAX_BIND_RETRIES {
                                thread::sleep(Duration::from_secs(BIND_RETRY_DELAY_SECS));
                            }
                        }
                    }
                }
                match bound {
                    Some(s) => s,
                    None => {
                        observability::log_error(
                            "clip_server",
                            "port_conflict",
                            &[("port", &PORT.to_string()), ("error", &last_err)],
                        );
                        DAEMON_STATUS.store(2, Ordering::Relaxed);
                        return;
                    }
                }
            };

            DAEMON_STATUS.store(1, Ordering::Relaxed);
            restart_count = 0;
            observability::log_info(
                "clip_server",
                "listening",
                &[("url", &format!("http://127.0.0.1:{PORT}"))],
            );

            for mut request in server.incoming_requests() {
                let request_id = observability::next_request_id();
                let method = request.method().clone();
                let url = request.url().to_string();
                let headers = headers_from_request(&request);

                if method == Method::Options {
                    respond_options(request, &headers);
                    continue;
                }

                let app = clip_app_handle();
                let (status, body) = match (method.clone(), url.as_str()) {
                    (Method::Get, "/status") => (
                        200,
                        serde_json::json!({
                            "ok": true,
                            "version": env!("CARGO_PKG_VERSION"),
                            "authRequired": app.as_ref().map(local_auth::api_auth_required).unwrap_or(true),
                            "authConfigured": app.as_ref().and_then(|a| local_auth::api_token(a)).is_some(),
                        })
                        .to_string(),
                    ),
                    (Method::Get, "/project") => {
                        if !clip_authorized(app.as_ref(), &headers, &request_id, "/project") {
                            (401, r#"{"ok":false,"error":"Unauthorized"}"#.to_string())
                        } else {
                            let path = CURRENT_PROJECT.lock().unwrap().clone();
                            (
                                200,
                                serde_json::json!({ "ok": true, "path": path }).to_string(),
                            )
                        }
                    }
                    (Method::Post, "/project") => {
                        if !clip_authorized(app.as_ref(), &headers, &request_id, "/project") {
                            (401, r#"{"ok":false,"error":"Unauthorized"}"#.to_string())
                        } else {
                            match read_limited_body(&mut request) {
                                Ok(body) => {
                                    let result = handle_set_project(&body);
                                    let status = if result.contains(r#""ok":true"#) {
                                        200
                                    } else {
                                        400
                                    };
                                    (status, result)
                                }
                                Err(e) => (400, e),
                            }
                        }
                    }
                    (Method::Get, "/projects") => {
                        if !clip_authorized(app.as_ref(), &headers, &request_id, "/projects") {
                            (401, r#"{"ok":false,"error":"Unauthorized"}"#.to_string())
                        } else {
                            let projects = ALL_PROJECTS.lock().unwrap().clone();
                            let current = CURRENT_PROJECT.lock().unwrap().clone();
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
                            (
                                200,
                                serde_json::json!({ "ok": true, "projects": items }).to_string(),
                            )
                        }
                    }
                    (Method::Post, "/projects") => {
                        if !clip_authorized(app.as_ref(), &headers, &request_id, "/projects") {
                            (401, r#"{"ok":false,"error":"Unauthorized"}"#.to_string())
                        } else {
                            let status_body = match read_limited_body(&mut request) {
                                Ok(body) => {
                                    if let Ok(parsed) =
                                        serde_json::from_str::<serde_json::Value>(&body)
                                    {
                                        if let Some(arr) = parsed["projects"].as_array() {
                                            let mut projects = ALL_PROJECTS.lock().unwrap();
                                            projects.clear();
                                            for item in arr {
                                                let name =
                                                    item["name"].as_str().unwrap_or("").to_string();
                                                let path =
                                                    item["path"].as_str().unwrap_or("").to_string();
                                                if validate_registered_project_path(&path).is_ok() {
                                                    projects.push((name, path));
                                                }
                                            }
                                        }
                                    }
                                    (200, r#"{"ok":true}"#.to_string())
                                }
                                Err(e) => (400, e),
                            };
                            status_body
                        }
                    }
                    (Method::Get, "/clips/pending") => {
                        if !clip_authorized(app.as_ref(), &headers, &request_id, "/clips/pending")
                        {
                            (401, r#"{"ok":false,"error":"Unauthorized"}"#.to_string())
                        } else {
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
                            let body = serde_json::json!({
                                "ok": true,
                                "clips": clips_json,
                            })
                            .to_string();
                            pending.clear();
                            (200, body)
                        }
                    }
                    (Method::Post, "/clip") => {
                        if !clip_authorized(app.as_ref(), &headers, &request_id, "/clip") {
                            (401, r#"{"ok":false,"error":"Unauthorized"}"#.to_string())
                        } else {
                            match read_limited_body(&mut request) {
                                Ok(body) => {
                                    let result = handle_clip(&body);
                                    let status = if result.contains(r#""ok":true"#) {
                                        200
                                    } else {
                                        500
                                    };
                                    (status, result)
                                }
                                Err(e) => (400, e),
                            }
                        }
                    }
                    _ => (404, r#"{"ok":false,"error":"Not found"}"#.to_string()),
                };

                respond_json(request, &headers, status, &body);
            }

            DAEMON_STATUS.store(3, Ordering::Relaxed);
            restart_count += 1;
            if restart_count >= MAX_RESTART_RETRIES {
                observability::log_error(
                    "clip_server",
                    "max_restarts",
                    &[("attempts", &MAX_RESTART_RETRIES.to_string())],
                );
                return;
            }
            thread::sleep(Duration::from_secs(RESTART_DELAY_SECS));
        }
    });
}

fn clip_app_handle() -> Option<AppHandle> {
    CLIP_APP.lock().ok().and_then(|g| g.clone())
}

fn clip_authorized(
    app: Option<&AppHandle>,
    headers: &[(String, String)],
    request_id: &str,
    path: &str,
) -> bool {
    let Some(app) = app else {
        return false;
    };
    if local_auth::is_authorized(app, headers) {
        return true;
    }
    local_auth::log_auth_denied("clip_server", path, request_id, app);
    false
}

fn headers_from_request(request: &tiny_http::Request) -> Vec<(String, String)> {
    request
        .headers()
        .iter()
        .map(|header| {
            (
                header.field.as_str().to_ascii_lowercase().to_string(),
                header.value.as_str().to_string(),
            )
        })
        .collect()
}

fn read_limited_body(request: &mut tiny_http::Request) -> Result<String, String> {
    let mut limited = request.as_reader().take(MAX_BODY_BYTES as u64 + 1);
    let mut bytes = Vec::new();
    limited
        .read_to_end(&mut bytes)
        .map_err(|e| format!(r#"{{"ok":false,"error":"Failed to read body: {e}"}}"#))?;
    if bytes.len() > MAX_BODY_BYTES {
        return Err(r#"{"ok":false,"error":"Request body too large"}"#.to_string());
    }
    String::from_utf8(bytes)
        .map_err(|_| r#"{"ok":false,"error":"Request body must be UTF-8"}"#.to_string())
}

fn respond_json(
    request: tiny_http::Request,
    request_headers: &[(String, String)],
    status: u16,
    body: &str,
) {
    let mut response = Response::from_string(body).with_status_code(status);
    for header in cors_headers_for_request(request_headers) {
        response.add_header(header);
    }
    let _ = request.respond(response);
}

fn respond_options(request: tiny_http::Request, request_headers: &[(String, String)]) {
    let mut response = Response::empty(tiny_http::StatusCode(204));
    for header in cors_headers_for_request(request_headers) {
        response.add_header(header);
    }
    let _ = request.respond(response);
}

fn cors_headers_for_request(request_headers: &[(String, String)]) -> Vec<Header> {
    let mut headers = vec![
        Header::from_bytes("Access-Control-Allow-Methods", "GET, POST, OPTIONS").unwrap(),
        Header::from_bytes(
            "Access-Control-Allow-Headers",
            "Content-Type, Authorization, X-LLM-Wiki-Token",
        )
        .unwrap(),
        Header::from_bytes("Content-Type", "application/json").unwrap(),
    ];
    if let Some(origin) = request_headers
        .iter()
        .find(|(k, _)| k == "origin")
        .map(|(_, v)| v.as_str())
    {
        if origin.starts_with("chrome-extension://") || origin == "null" {
            if let Ok(h) = Header::from_bytes("Access-Control-Allow-Origin", origin) {
                headers.push(h);
            }
        }
    }
    headers
}

fn paths_equal(a: &str, b: &str) -> bool {
    let a = a.replace('\\', "/").trim_end_matches('/').to_lowercase();
    let b = b.replace('\\', "/").trim_end_matches('/').to_lowercase();
    a == b
}

fn validate_registered_project_path(path: &str) -> Result<String, String> {
    let normalized = path.replace('\\', "/");
    if normalized.is_empty() {
        return Err("project path is empty".to_string());
    }
    let root = Path::new(&normalized);
    if !root.join("schema.md").exists() || !root.join("wiki").is_dir() {
        return Err("path is not a valid wiki project".to_string());
    }
    let current = current_project_path();
    let known = all_projects()
        .into_iter()
        .map(|(_, path)| path)
        .chain(std::iter::once(current))
        .filter(|p| !p.is_empty())
        .any(|p| paths_equal(&p, &normalized));
    if !known {
        return Err("projectPath is not registered with the desktop app".to_string());
    }
    Ok(normalized)
}

fn handle_set_project(body: &str) -> String {
    let parsed: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => return format!(r#"{{"ok":false,"error":"Invalid JSON: {e}"}}"#),
    };

    let path = match parsed["path"].as_str() {
        Some(p) => p.replace('\\', "/"),
        None => return r#"{"ok":false,"error":"path field is required"}"#.to_string(),
    };

    if let Err(e) = validate_registered_project_path(&path) {
        return format!(r#"{{"ok":false,"error":"{e}"}}"#);
    }

    match CURRENT_PROJECT.lock() {
        Ok(mut guard) => {
            *guard = path;
            r#"{"ok":true}"#.to_string()
        }
        Err(e) => format!(r#"{{"ok":false,"error":"Lock error: {e}"}}"#),
    }
}

fn handle_clip(body: &str) -> String {
    let parsed: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => return format!(r#"{{"ok":false,"error":"Invalid JSON: {e}"}}"#),
    };

    let title = parsed["title"].as_str().unwrap_or("Untitled");
    let url = parsed["url"].as_str().unwrap_or("");
    let content = parsed["content"].as_str().unwrap_or("");

    let project_path_from_body = parsed["projectPath"].as_str().unwrap_or("").to_string();
    let project_path = if project_path_from_body.is_empty() {
        match CURRENT_PROJECT.lock() {
            Ok(guard) => guard.clone(),
            Err(e) => return format!(r#"{{"ok":false,"error":"Lock error: {e}"}}"#),
        }
    } else {
        project_path_from_body
    };
    let project_path = project_path.replace('\\', "/");

    if let Err(e) = validate_registered_project_path(&project_path) {
        return format!(r#"{{"ok":false,"error":"{e}"}}"#);
    }

    if content.is_empty() {
        return r#"{"ok":false,"error":"content is required"}"#.to_string();
    }

    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    let date_compact = chrono::Local::now().format("%Y%m%d").to_string();

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

    let base_name = format!("{slug}-{date_compact}");
    let dir_path = Path::new(&project_path).join("raw").join("sources");

    if let Err(e) = std::fs::create_dir_all(&dir_path) {
        return format!(r#"{{"ok":false,"error":"Failed to create directory: {e}"}}"#);
    }

    let mut file_path = dir_path.join(format!("{base_name}.md"));
    let mut counter = 2u32;
    while file_path.exists() {
        file_path = dir_path.join(format!("{base_name}-{counter}.md"));
        counter += 1;
    }
    let file_path = file_path.to_string_lossy().replace('\\', "/");

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
        return format!(r#"{{"ok":false,"error":"Failed to write file: {e}"}}"#);
    }

    let relative_path = {
        let full = Path::new(&file_path);
        let base = Path::new(&project_path);
        full.strip_prefix(base)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| file_path.replace('\\', "/"))
    };

    if let Ok(mut pending) = PENDING_CLIPS.lock() {
        pending.push((project_path, file_path.clone()));
    }

    serde_json::json!({
        "ok": true,
        "path": relative_path,
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_project() -> (String, std::path::PathBuf) {
        let id = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("llm-wiki-clip-test-{id}"));
        fs::create_dir_all(root.join("wiki")).unwrap();
        fs::write(root.join("schema.md"), "# schema").unwrap();
        let path = root.to_string_lossy().replace('\\', "/");
        (path, root)
    }

    #[test]
    fn rejects_unregistered_project_paths() {
        let (path, root) = temp_project();
        assert!(validate_registered_project_path(&path).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn accepts_registered_project_paths() {
        let (path, root) = temp_project();
        ALL_PROJECTS.lock().unwrap().push(("t".into(), path.clone()));
        assert!(validate_registered_project_path(&path).is_ok());
        ALL_PROJECTS.lock().unwrap().clear();
        let _ = fs::remove_dir_all(root);
    }
}
