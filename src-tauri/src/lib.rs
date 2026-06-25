mod agent;
mod api_server;
mod clip_server;
mod commands;
mod cors;
mod panic_guard;
mod proxy;
mod server_bind;
mod tray;
mod types;

use panic_guard::run_guarded;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use uuid::Uuid;

struct CloseBehaviorState(Mutex<String>);
struct TrayAvailabilityState(Mutex<bool>);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentProjectEntry {
    id: String,
    name: String,
    path: String,
    current: bool,
}

#[derive(Debug, Clone, Default)]
struct AgentRuntimeConfig {
    embedding: Option<commands::search::SearchEmbeddingConfig>,
    llm: Option<agent::provider::LlmConfig>,
    web_search: Option<agent::tools::WebSearchConfig>,
    anytxt: Option<agent::tools::AnyTxtConfig>,
}

#[tauri::command]
fn clip_server_status() -> String {
    run_guarded("clip_server_status", || {
        Ok(clip_server::get_daemon_status().to_string())
    })
    .unwrap_or_else(|e| format!("error: {e}"))
}

#[tauri::command]
fn api_server_status() -> String {
    run_guarded("api_server_status", || {
        Ok(api_server::get_api_status().to_string())
    })
    .unwrap_or_else(|e| format!("error: {e}"))
}

#[tauri::command]
fn api_server_reload_config() -> String {
    run_guarded("api_server_reload_config", || {
        api_server::invalidate_config_cache();
        Ok("ok".to_string())
    })
    .unwrap_or_else(|e| format!("error: {e}"))
}

#[tauri::command]
async fn agent_start_turn(
    app: tauri::AppHandle,
    project_id: String,
    mut request: agent::AgentChatRequest,
) -> Result<agent::types::AgentChatResponse, String> {
    let project = resolve_agent_project(&app, &project_id)?;
    if request
        .session_id
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .is_empty()
    {
        request.session_id = Some(format!("ui_{}", Uuid::new_v4()));
    }
    let active_session_id = request.session_id.clone().unwrap_or_default();
    if request
        .run_id
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .is_empty()
    {
        request.run_id = Some(format!("run_{}", Uuid::new_v4()));
    }
    let active_run_id = request.run_id.clone().unwrap_or_default();
    if let Some(session_id) = request.session_id.clone() {
        if request.history.is_empty() && !request.history_explicit {
            request.history = app
                .state::<agent::session::AgentSessionStore>()
                .recent_messages(&project.path, &session_id, 12)
                .into_iter()
                .map(|message| agent::types::AgentConversationMessage {
                    role: message.role,
                    content: message.content,
                })
                .collect();
        }
    }
    let runtime_config = load_agent_runtime_config(&app);
    let runtime = agent::AgentRuntime::new(
        project.id.clone(),
        project.path.clone(),
        runtime_config.embedding,
        runtime_config.llm,
        runtime_config.web_search,
        runtime_config.anytxt,
    );
    let user_message = request.message.clone();
    let persist_session = request.persist_session;
    let cancellation = app
        .state::<agent::cancel::AgentCancellationRegistry>()
        .start(&project.id, &active_session_id, &active_run_id);
    let result = runtime
        .run_once_with_cancel(request, Some(cancellation))
        .await;
    app.state::<agent::cancel::AgentCancellationRegistry>()
        .finish(&project.id, &active_session_id, &active_run_id);
    let response = result?;
    if persist_session {
        app.state::<agent::session::AgentSessionStore>()
            .append_turn(
                &project.path,
                &project.id,
                &response.session_id,
                &user_message,
                &response.message,
            );
    }
    Ok(response)
}

#[tauri::command]
fn agent_cancel_turn(
    app: tauri::AppHandle,
    project_id: String,
    session_id: String,
    run_id: Option<String>,
) -> Result<bool, String> {
    let project = resolve_agent_project(&app, &project_id)?;
    Ok(app
        .state::<agent::cancel::AgentCancellationRegistry>()
        .cancel(&project.id, &session_id, run_id.as_deref()))
}

#[tauri::command]
async fn agent_start_turn_stream(
    app: tauri::AppHandle,
    project_id: String,
    mut request: agent::AgentChatRequest,
) -> Result<String, String> {
    let project = resolve_agent_project(&app, &project_id)?;
    if request
        .session_id
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .is_empty()
    {
        request.session_id = Some(format!("ui_{}", Uuid::new_v4()));
    }
    let active_session_id = request.session_id.clone().unwrap_or_default();
    if request
        .run_id
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .is_empty()
    {
        request.run_id = Some(format!("run_{}", Uuid::new_v4()));
    }
    let active_run_id = request.run_id.clone().unwrap_or_default();
    if request.history.is_empty() && !request.history_explicit {
        request.history = app
            .state::<agent::session::AgentSessionStore>()
            .recent_messages(&project.path, &active_session_id, 12)
            .into_iter()
            .map(|message| agent::types::AgentConversationMessage {
                role: message.role,
                content: message.content,
            })
            .collect();
    }
    let runtime_config = load_agent_runtime_config(&app);
    let runtime = agent::AgentRuntime::new(
        project.id.clone(),
        project.path.clone(),
        runtime_config.embedding,
        runtime_config.llm,
        runtime_config.web_search,
        runtime_config.anytxt,
    );
    let app_for_task = app.clone();
    let project_for_task = project.clone();
    let session_for_task = active_session_id.clone();
    let run_for_task = active_run_id.clone();
    let user_message = request.message.clone();
    let persist_session = request.persist_session;
    let cancellation = app
        .state::<agent::cancel::AgentCancellationRegistry>()
        .start(&project.id, &active_session_id, &active_run_id);
    tauri::async_runtime::spawn(async move {
        let emit_app = app_for_task.clone();
        let emit_session = session_for_task.clone();
        let emit_run = run_for_task.clone();
        let sink: agent::runtime::AgentEventSink = std::sync::Arc::new(move |event| {
            let _ = emit_app.emit(
                "agent-event",
                serde_json::json!({
                    "sessionId": emit_session.clone(),
                    "runId": emit_run.clone(),
                    "event": event,
                }),
            );
        });
        let result = runtime
            .run_once_with_cancel_and_events(request, Some(cancellation), Some(sink))
            .await;
        app_for_task
            .state::<agent::cancel::AgentCancellationRegistry>()
            .finish(&project_for_task.id, &session_for_task, &run_for_task);
        match result {
            Ok(response) => {
                if persist_session {
                    app_for_task
                        .state::<agent::session::AgentSessionStore>()
                        .append_turn(
                            &project_for_task.path,
                            &project_for_task.id,
                            &response.session_id,
                            &user_message,
                            &response.message,
                        );
                }
            }
            Err(err) => {
                let _ = app_for_task.emit(
                    "agent-event",
                    serde_json::json!({
                        "sessionId": session_for_task,
                        "runId": run_for_task,
                        "event": { "type": "error", "message": err },
                    }),
                );
            }
        }
    });
    Ok(active_session_id)
}

#[tauri::command]
fn agent_get_session(
    app: tauri::AppHandle,
    project_id: String,
    session_id: String,
    limit: Option<usize>,
) -> Result<Vec<agent::session::AgentSessionMessage>, String> {
    let project = resolve_agent_project(&app, &project_id)?;
    Ok(app
        .state::<agent::session::AgentSessionStore>()
        .recent_messages(
            &project.path,
            &session_id,
            limit.unwrap_or(40).clamp(1, 200),
        ))
}

#[tauri::command]
fn agent_list_sessions(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<Vec<agent::session::AgentSession>, String> {
    let project = resolve_agent_project(&app, &project_id)?;
    Ok(app
        .state::<agent::session::AgentSessionStore>()
        .list_sessions(&project.path))
}

#[tauri::command]
fn mcp_server_entry_path(app: tauri::AppHandle) -> Result<String, String> {
    run_guarded("mcp_server_entry_path", || {
        let relative = std::path::Path::new("mcp-server")
            .join("dist")
            .join("src")
            .join("index.js");
        let mut candidates = Vec::new();

        let mut push_repo_candidates = |base: std::path::PathBuf| {
            candidates.push(base.join(&relative));
            candidates.push(base.join("..").join(&relative));
            candidates.push(base.join("..").join("..").join(&relative));
        };

        push_repo_candidates(std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")));
        if let Ok(cwd) = std::env::current_dir() {
            push_repo_candidates(cwd);
        }
        if let Ok(resource_dir) = app.path().resource_dir() {
            candidates.push(resource_dir.join(&relative));
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(exe_dir) = exe.parent() {
                candidates.push(exe_dir.join(&relative));
                candidates.push(exe_dir.join("..").join("Resources").join(&relative));
            }
        }

        for candidate in &candidates {
            if candidate.is_file() {
                return Ok(candidate
                    .canonicalize()
                    .unwrap_or_else(|_| candidate.clone())
                    .to_string_lossy()
                    .into_owned());
            }
        }

        Err("MCP server entry was not found. Run `npm run mcp:build` from the LLM Wiki repository, then reopen Settings.".to_string())
    })
}

fn resolve_agent_project(
    app: &tauri::AppHandle,
    project_id: &str,
) -> Result<AgentProjectEntry, String> {
    let decoded = percent_decode(project_id);
    let wants_current = decoded.eq_ignore_ascii_case("current");
    load_agent_projects(app)
        .into_iter()
        .find(|project| {
            project.id == decoded
                || project_path_matches(&project.path, &decoded)
                || (wants_current && project.current)
        })
        .ok_or_else(|| format!("Unknown project: {decoded}"))
}

fn load_agent_projects(app: &tauri::AppHandle) -> Vec<AgentProjectEntry> {
    let current = normalize_path(&clip_server::current_project_path());
    let mut projects = Vec::new();
    if let Some(parsed) = load_agent_app_state(app) {
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
                projects.push(AgentProjectEntry {
                    id: id.clone(),
                    name,
                    current: path == current,
                    path,
                });
            }
        }
        if let Some(recents) = parsed.get("recentProjects").and_then(Value::as_array) {
            for value in recents {
                let path = value.get("path").and_then(Value::as_str).unwrap_or("");
                if path.is_empty() {
                    continue;
                }
                let path = normalize_path(path);
                if projects.iter().any(|project| project.path == path) {
                    continue;
                }
                let name = value
                    .get("name")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
                    .unwrap_or_else(|| project_name_from_path(&path));
                projects.push(AgentProjectEntry {
                    id: read_project_id(&path).unwrap_or_else(|| path.clone()),
                    name,
                    current: path == current,
                    path,
                });
            }
        }
    }
    if !current.is_empty() && !projects.iter().any(|project| project.path == current) {
        projects.push(AgentProjectEntry {
            id: read_project_id(&current).unwrap_or_else(|| current.clone()),
            name: project_name_from_path(&current),
            current: true,
            path: current,
        });
    }
    projects
}

fn load_agent_app_state(app: &tauri::AppHandle) -> Option<Value> {
    let path = app.path().app_data_dir().ok()?.join("app-state.json");
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn load_agent_runtime_config(app: &tauri::AppHandle) -> AgentRuntimeConfig {
    let Some(parsed) = load_agent_app_state(app) else {
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

fn read_project_id(path: &str) -> Option<String> {
    let raw = std::fs::read_to_string(
        std::path::Path::new(path)
            .join(".llm-wiki")
            .join("project.json"),
    )
    .ok()?;
    serde_json::from_str::<Value>(&raw)
        .ok()?
        .get("id")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn project_name_from_path(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("Project")
        .to_string()
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

fn normalize_path(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').to_string()
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push((hi << 4) | lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| input.to_string())
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Apply a proxy configuration to the process env immediately, so the
/// next outbound HTTP request picks it up without needing the user to
/// restart the app. tauri-plugin-http builds a fresh
/// `reqwest::ClientBuilder` per fetch and reqwest's `auto_sys_proxy`
/// re-reads HTTP_PROXY / HTTPS_PROXY / NO_PROXY each time, so updating
/// these env vars is sufficient to flip the proxy on/off live.
///
/// Returns the same human-readable summary `apply_proxy_env` produces
/// for logging.
#[tauri::command]
fn set_proxy_env(config: proxy::ProxyConfig) -> String {
    let summary = proxy::apply_proxy_env(&config);
    eprintln!("[proxy] live update: {summary}");
    summary
}

#[tauri::command]
fn set_close_behavior(
    value: String,
    state: tauri::State<'_, CloseBehaviorState>,
) -> Result<String, String> {
    let normalized = match value.as_str() {
        "ask" | "minimize" | "exit" => value,
        other => return Err(format!("Invalid close behavior: {other}")),
    };
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "Close behavior state is unavailable".to_string())?;
    *guard = normalized.clone();
    Ok(normalized)
}

fn close_behavior<R: tauri::Runtime>(window: &tauri::Window<R>) -> String {
    window
        .state::<CloseBehaviorState>()
        .0
        .lock()
        .map(|value| value.clone())
        .unwrap_or_else(|_| "minimize".to_string())
}

fn tray_available<R: tauri::Runtime>(window: &tauri::Window<R>) -> bool {
    window
        .state::<TrayAvailabilityState>()
        .0
        .lock()
        .map(|value| *value)
        .unwrap_or(false)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    apply_linux_webkit_compat_env();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None::<Vec<&str>>,
        ))
        // Rust-backed fetch so third-party LLM APIs that reject
        // browser-origin headers via CORS preflight (MiniMax, Volcengine
        // Ark's api/coding/v3, etc.) still work. Requests leave the app
        // from Rust, never the webview.
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            // Let the PDF extractor find the bundled pdfium dynamic
            // library via Tauri's platform-correct resource path.
            if let Ok(dir) = app.path().resource_dir() {
                commands::fs::set_resource_dir_hint(dir);
            }
            // Apply user-configured global HTTP proxy by setting
            // HTTP_PROXY / HTTPS_PROXY / NO_PROXY env vars BEFORE
            // any HTTP request is made. tauri-plugin-http's reqwest
            // client reads these on first construction. Lives next
            // to the resource-dir hint so the proxy applies to
            // everything: LLM, embedding, update check, deep
            // research, captioning. See src-tauri/src/proxy.rs.
            if let Ok(dir) = app.path().app_data_dir() {
                let store_path = dir.join("app-state.json");
                eprintln!("[proxy] reading from {}", store_path.display());
                if let Some(cfg) = proxy::read_proxy_config_from_store(&store_path) {
                    let summary = proxy::apply_proxy_env(&cfg);
                    eprintln!("[proxy] {summary}");
                } else {
                    eprintln!("[proxy] no proxyConfig in store, requests go direct");
                }
            } else {
                eprintln!("[proxy] could not resolve app_data_dir");
            }
            // Registry of running `claude` subprocesses, keyed by the
            // frontend-generated stream id. Populated by claude_cli_spawn,
            // drained on process exit or by claude_cli_kill.
            app.manage(commands::claude_cli::ClaudeCliState::default());
            app.manage(commands::codex_cli::CodexCliState::default());
            app.manage(commands::file_sync::FileSyncState::default());
            app.manage(agent::session::AgentSessionStore::default());
            app.manage(agent::cancel::AgentCancellationRegistry::default());
            app.manage(CloseBehaviorState(Mutex::new("minimize".to_string())));
            app.manage(TrayAvailabilityState(Mutex::new(false)));
            // Start the API before optional desktop integrations so the
            // backend is reachable if tray setup or another integration fails.
            clip_server::start_clip_server(app.handle().clone());
            api_server::start_api_server(app.handle().clone());
            let tray_available = match tray::create_tray(app.handle()) {
                Ok(()) => true,
                Err(err) => {
                    eprintln!("[tray] system tray unavailable, continuing without it: {err}");
                    false
                }
            };
            match app.state::<TrayAvailabilityState>().0.lock() {
                Ok(mut state) => {
                    *state = tray_available;
                }
                Err(err) => {
                    eprintln!("[tray] failed to update tray availability state: {err}");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::fs::read_file,
            commands::fs::write_file,
            commands::fs::write_file_base64,
            commands::fs::write_file_atomic,
            commands::fs::apply_text_selection_edit,
            commands::fs::create_missing_wiki_page,
            commands::file_history::list_file_history,
            commands::file_history::restore_file_history,
            commands::fs::list_directory,
            commands::fs::copy_file,
            commands::fs::copy_directory,
            commands::fs::preprocess_file,
            commands::fs::delete_file,
            commands::fs::find_related_wiki_pages,
            commands::fs::create_directory,
            commands::fs::file_exists,
            commands::fs::get_file_modified_time,
            commands::fs::get_file_size,
            commands::fs::get_file_md5,
            commands::fs::read_file_as_base64,
            commands::project::create_project,
            commands::project::open_project,
            commands::project::open_project_folder,
            commands::project::open_path_in_project,
            commands::search::search_project,
            commands::search::embedding_fetch,
            commands::search::get_page_links,
            commands::external_search::web_search,
            commands::external_search::anytxt_search,
            clip_server_status,
            api_server_status,
            api_server_reload_config,
            agent_start_turn,
            agent_start_turn_stream,
            agent_cancel_turn,
            agent_get_session,
            agent_list_sessions,
            agent::skills::agent_list_skills,
            mcp_server_entry_path,
            commands::vectorstore::vector_upsert,
            commands::vectorstore::vector_search,
            commands::vectorstore::vector_delete,
            commands::vectorstore::vector_count,
            commands::vectorstore::vector_upsert_chunks,
            commands::vectorstore::vector_search_chunks,
            commands::vectorstore::vector_delete_page,
            commands::vectorstore::vector_count_chunks,
            commands::vectorstore::vector_clear_chunks,
            commands::vectorstore::vector_optimize_chunks,
            commands::vectorstore::vector_legacy_row_count,
            commands::vectorstore::vector_drop_legacy,
            commands::claude_cli::claude_cli_detect,
            commands::claude_cli::claude_cli_spawn,
            commands::claude_cli::claude_cli_kill,
            commands::codex_cli::codex_cli_detect,
            commands::codex_cli::codex_cli_spawn,
            commands::codex_cli::codex_cli_kill,
            commands::extract_images::extract_pdf_images_cmd,
            commands::extract_images::extract_office_images_cmd,
            commands::extract_images::extract_and_save_pdf_images_cmd,
            commands::extract_images::extract_and_save_office_images_cmd,
            commands::file_sync::start_project_file_watcher,
            commands::file_sync::stop_project_file_watcher,
            commands::file_sync::rescan_project_files,
            commands::file_sync::get_file_change_queue,
            commands::file_sync::retry_file_change_task,
            commands::file_sync::ignore_file_change_task,
            set_proxy_env,
            set_close_behavior,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let behavior = close_behavior(window);
                let win = window.clone();
                let app = window.app_handle().clone();
                match behavior.as_str() {
                    "exit" => {
                        tauri::async_runtime::spawn(async move {
                            let _ = win.destroy();
                            app.exit(0);
                        });
                    }
                    "minimize" => {
                        if tray_available(window) {
                            let _ = window.hide();
                        } else {
                            let _ = window.minimize();
                        }
                    }
                    _ => {
                        tauri::async_runtime::spawn(async move {
                            use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
                            let confirmed = app
                                .dialog()
                                .message(
                                    "Quit LLM Wiki? Choose Quit to exit. Choose Hide Window to keep background features running.",
                                )
                                .title("LLM Wiki")
                                .buttons(MessageDialogButtons::OkCancelCustom(
                                    "Quit".to_string(),
                                    "Hide Window".to_string(),
                                ))
                                .kind(tauri_plugin_dialog::MessageDialogKind::Warning)
                                .blocking_show();

                            if confirmed {
                                let _ = win.destroy();
                                app.exit(0);
                            } else {
                                let _ = win.hide();
                            }
                        });
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } = event
            {
                if !has_visible_windows {
                    use tauri::Manager;
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
            let _ = (app, event); // suppress unused warnings on non-macOS
        });
}

#[cfg(target_os = "linux")]
fn apply_linux_webkit_compat_env() {
    // WebKitGTK can crash during startup on some Wayland compositors
    // (reported on Fedora 44) unless compositing mode is disabled before
    // the WebView is created. Keep this as a Linux-only default and do not
    // override an explicit user setting so advanced users and packagers can
    // opt back into the platform default if their stack supports it.
    if std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_none() {
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
    }
}

#[cfg(not(target_os = "linux"))]
fn apply_linux_webkit_compat_env() {}
