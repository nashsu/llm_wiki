use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Mutex;
use std::thread;
use tauri::AppHandle;
use tiny_http::{Header, Method, Response, Server};

use crate::cors::{local_cors_headers, request_origin};
use crate::server_bind;

static CURRENT_PROJECT: Mutex<String> = Mutex::new(String::new());
static ALL_PROJECTS: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new()); // (name, path)
static PENDING_CLIPS: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new()); // (projectPath, filePath)

/// Daemon status: 0=starting, 1=running, 2=port_conflict, 3=error
static DAEMON_STATUS: AtomicU8 = AtomicU8::new(0);

const PORT: u16 = 19827;
const MAX_BIND_RETRIES: u32 = 3;
const MAX_RESTART_RETRIES: u32 = 10;
const BIND_RETRY_DELAY_SECS: u64 = 2;
const RESTART_DELAY_SECS: u64 = 5;

/// Get current daemon status as a string
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
    thread::spawn(move || {
        let mut restart_count: u32 = 0;

        loop {
            // Try to bind the port with retries
            let (server, addr) = {
                let host = server_bind::configured_bind_host(&app);
                let addr = server_bind::bind_addr(&host, PORT);
                let mut last_err = String::new();
                let mut bound = None;
                for attempt in 1..=MAX_BIND_RETRIES {
                    match Server::http(&addr) {
                        Ok(s) => {
                            bound = Some(s);
                            break;
                        }
                        Err(e) => {
                            last_err = format!("{}", e);
                            eprintln!(
                                "[Clip Server] Bind attempt {}/{} failed for {}: {}",
                                attempt, MAX_BIND_RETRIES, addr, e
                            );
                            if attempt < MAX_BIND_RETRIES {
                                thread::sleep(std::time::Duration::from_secs(
                                    BIND_RETRY_DELAY_SECS,
                                ));
                            }
                        }
                    }
                }
                match bound {
                    Some(s) => (s, addr),
                    None => {
                        eprintln!(
                            "[Clip Server] Address {} unavailable after {} attempts: {}",
                            addr, MAX_BIND_RETRIES, last_err
                        );
                        DAEMON_STATUS.store(2, Ordering::Relaxed); // port_conflict
                        return; // Don't retry on port conflict — needs user action
                    }
                }
            };

            DAEMON_STATUS.store(1, Ordering::Relaxed); // running
            restart_count = 0; // Reset on successful bind
            println!("[Clip Server] Listening on http://{}", addr);

            for mut request in server.incoming_requests() {
                let origin = request_origin(&request);
                let cors_headers = cors_headers(origin.as_deref());

                // Handle CORS preflight
                if request.method() == &Method::Options {
                    let mut response = Response::from_string("").with_status_code(204);
                    for h in &cors_headers {
                        response.add_header(h.clone());
                    }
                    response
                        .add_header(Header::from_bytes("Access-Control-Max-Age", "600").unwrap());
                    let _ = request.respond(response);
                    continue;
                }

                let url = request.url().to_string();

                match (request.method(), url.as_str()) {
                    (&Method::Get, "/status") => {
                        let body = r#"{"ok":true,"version":"0.1.0"}"#;
                        let mut response = Response::from_string(body);
                        for h in &cors_headers {
                            response.add_header(h.clone());
                        }
                        let _ = request.respond(response);
                    }
                    (&Method::Get, "/project") => {
                        let path = CURRENT_PROJECT.lock().unwrap().clone();
                        // serde_json handles backslash escaping so a Windows
                        // path that somehow still contains `\` won't break
                        // the JSON parser on the client.
                        let body = serde_json::json!({
                            "ok": true,
                            "path": path,
                        })
                        .to_string();
                        let mut response = Response::from_string(body);
                        for h in &cors_headers {
                            response.add_header(h.clone());
                        }
                        let _ = request.respond(response);
                    }
                    (&Method::Post, "/project") => {
                        let mut body = String::new();
                        if let Err(e) = request.as_reader().read_to_string(&mut body) {
                            let err =
                                format!(r#"{{"ok":false,"error":"Failed to read body: {}"}}"#, e);
                            let mut response = Response::from_string(err).with_status_code(400);
                            for h in &cors_headers {
                                response.add_header(h.clone());
                            }
                            let _ = request.respond(response);
                            continue;
                        }

                        let result = handle_set_project(&body);
                        let status = if result.contains(r#""ok":true"#) {
                            200
                        } else {
                            400
                        };
                        let mut response = Response::from_string(result).with_status_code(status);
                        for h in &cors_headers {
                            response.add_header(h.clone());
                        }
                        let _ = request.respond(response);
                    }
                    (&Method::Get, "/projects") => {
                        let projects = ALL_PROJECTS.lock().unwrap().clone();
                        let current = CURRENT_PROJECT.lock().unwrap().clone();
                        // serde_json for proper escaping of `\`, `"`, and any
                        // other characters that might appear in a project name
                        // or path. Previously only `"` was escaped by hand,
                        // which broke on Windows paths containing backslashes.
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
                        let body = serde_json::json!({
                            "ok": true,
                            "projects": items,
                        })
                        .to_string();
                        let mut response = Response::from_string(body);
                        for h in &cors_headers {
                            response.add_header(h.clone());
                        }
                        let _ = request.respond(response);
                    }
                    (&Method::Post, "/projects") => {
                        let mut body = String::new();
                        if request.as_reader().read_to_string(&mut body).is_ok() {
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
                        }
                        let mut response = Response::from_string(r#"{"ok":true}"#);
                        for h in &cors_headers {
                            response.add_header(h.clone());
                        }
                        let _ = request.respond(response);
                    }
                    (&Method::Get, "/clips/pending") => {
                        let mut pending = PENDING_CLIPS.lock().unwrap();
                        // Use serde_json for proper escaping of both quotes
                        // and backslashes — hand-rolled escaping previously
                        // produced invalid JSON on Windows paths containing
                        // \r, \s, etc.
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
                        let mut response = Response::from_string(body);
                        for h in &cors_headers {
                            response.add_header(h.clone());
                        }
                        let _ = request.respond(response);
                    }
                    (&Method::Post, "/clip") => {
                        let mut body = String::new();
                        if let Err(e) = request.as_reader().read_to_string(&mut body) {
                            let err =
                                format!(r#"{{"ok":false,"error":"Failed to read body: {}"}}"#, e);
                            let mut response = Response::from_string(err).with_status_code(400);
                            for h in &cors_headers {
                                response.add_header(h.clone());
                            }
                            let _ = request.respond(response);
                            continue;
                        }

                        let result = handle_clip(&body);
                        let status = if result.contains(r#""ok":true"#) {
                            200
                        } else {
                            500
                        };
                        let mut response = Response::from_string(result).with_status_code(status);
                        for h in &cors_headers {
                            response.add_header(h.clone());
                        }
                        let _ = request.respond(response);
                    }
                    _ => {
                        let body = r#"{"ok":false,"error":"Not found"}"#;
                        let mut response = Response::from_string(body).with_status_code(404);
                        for h in &cors_headers {
                            response.add_header(h.clone());
                        }
                        let _ = request.respond(response);
                    }
                }
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

fn cors_headers(origin: Option<&str>) -> Vec<Header> {
    local_cors_headers(origin, "Content-Type")
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
    let dir_path = std::path::Path::new(&project_path)
        .join("raw")
        .join("sources");

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
        return format!(r#"{{"ok":false,"error":"Failed to write file: {}"}}"#, e);
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
    })
    .to_string()
}
