//! Application-level commands shared by every host: agent chat turns,
//! session listing, server status, and the helpers that resolve project ids
//! against the persisted registry. These take an [`AppCtx`] so they run the
//! same way from Tauri IPC, the local HTTP API, and the web server RPC bridge.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::agent;
use crate::app_ctx::AppCtx;
use crate::commands;
use crate::panic_guard::run_guarded;
use crate::{api_server, clip_server, proxy};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProjectEntry {
    pub id: String,
    pub name: String,
    pub path: String,
    pub current: bool,
}

#[derive(Debug, Clone, Default)]
pub struct AgentRuntimeConfig {
    embedding: Option<commands::search::SearchEmbeddingConfig>,
    llm: Option<agent::provider::LlmConfig>,
    web_search: Option<agent::tools::WebSearchConfig>,
    anytxt: Option<agent::tools::AnyTxtConfig>,
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn clip_server_status() -> String {
    run_guarded("clip_server_status", || {
        Ok(clip_server::get_daemon_status().to_string())
    })
    .unwrap_or_else(|e| format!("error: {e}"))
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn api_server_status() -> String {
    run_guarded("api_server_status", || {
        Ok(api_server::get_api_status().to_string())
    })
    .unwrap_or_else(|e| format!("error: {e}"))
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn api_server_reload_config() -> String {
    run_guarded("api_server_reload_config", || {
        api_server::invalidate_config_cache();
        Ok("ok".to_string())
    })
    .unwrap_or_else(|e| format!("error: {e}"))
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn agent_start_turn(
    app: AppCtx,
    project_id: String,
    mut request: agent::AgentChatRequest,
    llm_config: Option<agent::provider::LlmConfig>,
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
    let mut runtime_config = load_agent_runtime_config(&app);
    runtime_config.llm = llm_config.or(runtime_config.llm);
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

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn agent_cancel_turn(
    app: AppCtx,
    project_id: String,
    session_id: String,
    run_id: Option<String>,
) -> Result<bool, String> {
    let project = resolve_agent_project(&app, &project_id)?;
    Ok(app
        .state::<agent::cancel::AgentCancellationRegistry>()
        .cancel(&project.id, &session_id, run_id.as_deref()))
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn agent_start_turn_stream(
    app: AppCtx,
    project_id: String,
    mut request: agent::AgentChatRequest,
    llm_config: Option<agent::provider::LlmConfig>,
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
    let mut runtime_config = load_agent_runtime_config(&app);
    runtime_config.llm = llm_config.or(runtime_config.llm);
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
    crate::rt::spawn(async move {
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

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn agent_get_session(
    app: AppCtx,
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

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn agent_list_sessions(
    app: AppCtx,
    project_id: String,
) -> Result<Vec<agent::session::AgentSession>, String> {
    let project = resolve_agent_project(&app, &project_id)?;
    Ok(app
        .state::<agent::session::AgentSessionStore>()
        .list_sessions(&project.path))
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn mcp_server_entry_path(app: AppCtx) -> Result<String, String> {
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
        if let Some(resource_dir) = app.resource_dir() {
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

pub fn resolve_agent_project(
    app: &AppCtx,
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

pub fn load_agent_projects(app: &AppCtx) -> Vec<AgentProjectEntry> {
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

pub fn load_agent_app_state(app: &AppCtx) -> Option<Value> {
    let path = app.app_state_path();
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn load_agent_runtime_config(app: &AppCtx) -> AgentRuntimeConfig {
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

pub fn read_project_id(path: &str) -> Option<String> {
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

pub fn project_name_from_path(path: &str) -> String {
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

pub fn normalize_path(path: &str) -> String {
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
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn set_proxy_env(config: proxy::ProxyConfig) -> String {
    let summary = proxy::apply_proxy_env(&config);
    eprintln!("[proxy] live update: {summary}");
    summary
}
