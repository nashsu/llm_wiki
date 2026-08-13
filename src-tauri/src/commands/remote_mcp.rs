//! Remote MCP access: spawns the bundled Node HTTP+OAuth bridge
//! (`mcp-server/dist/src/http-server.js`) as a child process so agents
//! outside this machine (ChatGPT, Codex, Claude.ai) can reach this
//! project's tools and, optionally, a linked Company Brain vault.
//!
//! Why a spawned Node child instead of a Rust-native server (unlike
//! api_server.rs's tiny_http server): the bridge already implements the
//! full MCP Streamable HTTP transport, dynamic client registration, and a
//! password-gated OAuth authorization server via @modelcontextprotocol/sdk
//! — porting that to Rust from scratch is a much larger undertaking than
//! managing one more child process, and the bridge is already bundled
//! into every platform build (see tauri.*.conf.json bundle.resources).
//! `node` is resolved via node_runtime::ensure_node — PATH first, and if
//! that fails, a one-time download of an official Node.js release (no
//! sidecar bundling, no requiring the user to install anything).
//!
//! Same tokio::process pattern as claude_cli.rs / codex_cli.rs: a single
//! long-lived child (not a per-call spawn), registered in RemoteMcpState so
//! it can be killed on Stop or on app exit.
//!
//! The frontend "Enable remote MCP access" checkbox is a live control, not
//! a draft field gated behind Settings' Save button (unlike most of this
//! screen): checking it starts the process and persists immediately;
//! unchecking it stops the process and persists immediately. That's what
//! makes `autostart_if_enabled` below correct — it only has to trust
//! whatever was last persisted, because persistence and process state are
//! kept in lockstep by the frontend, not deferred to a later Save.

use std::fs;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use super::node_runtime;

const LOG_TOPIC: &str = "remote-mcp:log";
const URL_TOPIC: &str = "remote-mcp:url";
const PUBLIC_URL_PREFIX: &str = "Public URL: ";

#[derive(Default)]
pub struct RemoteMcpState {
    child: Arc<Mutex<Option<Child>>>,
    /// The URL a client should actually connect to — either the configured
    /// domain or the Quick Tunnel's generated trycloudflare.com URL, parsed
    /// live from the child's stderr since only the child process knows
    /// which one it ended up using (see quick-tunnel.ts).
    public_url: Arc<Mutex<Option<String>>>,
}

#[derive(Serialize)]
pub struct RemoteMcpStatus {
    running: bool,
    #[serde(rename = "publicUrl")]
    public_url: Option<String>,
}

struct StartOptions {
    http_token: String,
    approval_password: String,
    port: u16,
    public_hostname: Option<String>,
    vault_root: Option<String>,
    llm_wiki_api_token: Option<String>,
}

/// Same candidate-path search as `mcp_server_entry_path` in lib.rs, just
/// pointed at http-server.js instead of index.js — kept as a standalone
/// copy rather than a shared helper, matching how app-state reads are
/// duplicated per-module elsewhere in this codebase rather than centralized.
fn resolve_http_server_entry(app: &AppHandle) -> Result<PathBuf, String> {
    let relative = PathBuf::from("mcp-server")
        .join("dist")
        .join("src")
        .join("http-server.js");
    let mut candidates = Vec::new();

    let mut push_repo_candidates = |base: PathBuf| {
        candidates.push(base.join(&relative));
        candidates.push(base.join("..").join(&relative));
        candidates.push(base.join("..").join("..").join(&relative));
    };

    push_repo_candidates(PathBuf::from(env!("CARGO_MANIFEST_DIR")));
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
            return Ok(candidate.canonicalize().unwrap_or_else(|_| candidate.clone()));
        }
    }

    Err("Remote MCP server entry was not found. Run `npm run mcp:build`, then reopen Settings.".to_string())
}

#[tauri::command]
pub async fn remote_mcp_status(state: State<'_, RemoteMcpState>) -> Result<RemoteMcpStatus, String> {
    let running = state.child.lock().await.is_some();
    let public_url = state.public_url.lock().await.clone();
    Ok(RemoteMcpStatus { running, public_url })
}

async fn spawn_remote_mcp(app: &AppHandle, state: &RemoteMcpState, opts: StartOptions) -> Result<(), String> {
    if state.child.lock().await.is_some() {
        return Err("Remote MCP server is already running. Stop it first.".to_string());
    }

    let node = node_runtime::ensure_node(app).await?;
    let entry = resolve_http_server_entry(app)?;

    let mut cmd = Command::new(&node);
    cmd.arg(&entry);
    cmd.env("MCP_HTTP_PORT", opts.port.to_string());
    cmd.env("MCP_HTTP_HOST", "127.0.0.1");
    cmd.env("MCP_HTTP_TOKEN", &opts.http_token);
    cmd.env("OAUTH_APPROVAL_PASSWORD", &opts.approval_password);
    if let Some(hostname) = opts.public_hostname.as_deref().filter(|h| !h.trim().is_empty()) {
        cmd.env("MCP_PUBLIC_HOSTNAME", hostname);
        cmd.env("MCP_HTTP_ALLOWED_HOSTS", hostname);
    }
    if let Some(root) = opts.vault_root.as_deref().filter(|v| !v.trim().is_empty()) {
        cmd.env("VAULT_ROOT", root);
    }
    if let Some(token) = opts.llm_wiki_api_token.as_deref().filter(|t| !t.trim().is_empty()) {
        cmd.env("LLM_WIKI_API_TOKEN", token);
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn remote MCP server (node at {}): {e}", node.display()))?;

    let stdout = child.stdout.take().ok_or_else(|| "Missing stdout handle".to_string())?;
    let stderr = child.stderr.take().ok_or_else(|| "Missing stderr handle".to_string())?;

    *state.child.lock().await = Some(child);
    *state.public_url.lock().await = None;

    let public_url_store = Arc::clone(&state.public_url);
    let app_for_task = app.clone();
    tokio::spawn(async move {
        let mut stdout_lines = BufReader::new(stdout).lines();
        let mut stderr_lines = BufReader::new(stderr).lines();
        loop {
            tokio::select! {
                line = stdout_lines.next_line() => {
                    match line {
                        Ok(Some(line)) => { let _ = app_for_task.emit(LOG_TOPIC, line); }
                        _ => break,
                    }
                }
                line = stderr_lines.next_line() => {
                    match line {
                        Ok(Some(line)) => {
                            if let Some(url) = line.strip_prefix(PUBLIC_URL_PREFIX) {
                                let url = url.trim().to_string();
                                *public_url_store.lock().await = Some(url.clone());
                                let _ = app_for_task.emit(URL_TOPIC, url);
                            }
                            let _ = app_for_task.emit(LOG_TOPIC, line);
                        }
                        _ => break,
                    }
                }
                else => break,
            }
        }
    });

    Ok(())
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn remote_mcp_start(
    app: AppHandle,
    state: State<'_, RemoteMcpState>,
    http_token: String,
    approval_password: String,
    port: u16,
    public_hostname: Option<String>,
    vault_root: Option<String>,
    llm_wiki_api_token: Option<String>,
) -> Result<(), String> {
    spawn_remote_mcp(
        &app,
        &state,
        StartOptions {
            http_token,
            approval_password,
            port,
            public_hostname,
            vault_root,
            llm_wiki_api_token,
        },
    )
    .await
}

#[tauri::command]
pub async fn remote_mcp_stop(state: State<'_, RemoteMcpState>) -> Result<(), String> {
    if let Some(mut child) = state.child.lock().await.take() {
        let _ = child.start_kill();
    }
    *state.public_url.lock().await = None;
    Ok(())
}

/// Called from the app-level RunEvent::Exit handler so the child doesn't
/// outlive the app (kill_on_drop alone only fires if the Child value is
/// actually dropped, which a plain process::exit() can skip).
pub fn kill_on_app_exit(app: &AppHandle) {
    let state = app.state::<RemoteMcpState>();
    let child_handle = Arc::clone(&state.child);
    tauri::async_runtime::block_on(async move {
        if let Some(mut child) = child_handle.lock().await.take() {
            let _ = child.start_kill();
        }
    });
}

fn load_app_state_once(app: &AppHandle) -> Option<Value> {
    let path = app.path().app_data_dir().ok()?.join("app-state.json");
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Called once from `.setup()`. If the user last left "Enable remote MCP
/// access" checked, the toggle's own handler already persisted
/// `remoteMcpEnabled: true` alongside the token/password/port/etc — so
/// resuming here is just replaying that same persisted config, not a
/// separate "was it enabled" heuristic.
pub async fn autostart_if_enabled(app: AppHandle) {
    let Some(state_json) = load_app_state_once(&app) else { return };
    let Some(api_config) = state_json.get("apiConfig") else { return };

    let enabled = api_config
        .get("remoteMcpEnabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !enabled {
        return;
    }

    let string_field = |key: &str| -> Option<String> {
        api_config.get(key).and_then(Value::as_str).map(str::to_string).filter(|s| !s.is_empty())
    };

    let Some(http_token) = string_field("remoteMcpToken") else {
        eprintln!("[remote-mcp] remoteMcpEnabled is true but remoteMcpToken is empty — skipping autostart");
        return;
    };
    let Some(approval_password) = string_field("remoteMcpApprovalPassword") else {
        eprintln!("[remote-mcp] remoteMcpEnabled is true but remoteMcpApprovalPassword is empty — skipping autostart");
        return;
    };
    let port = api_config
        .get("remoteMcpPort")
        .and_then(Value::as_u64)
        .and_then(|p| u16::try_from(p).ok())
        .unwrap_or(8931);
    let public_hostname = string_field("remoteMcpPublicHostname");
    let vault_root = string_field("remoteMcpVaultRoot");
    let allow_unauthenticated = api_config
        .get("allowUnauthenticated")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let llm_wiki_api_token = if allow_unauthenticated {
        None
    } else {
        std::env::var("LLM_WIKI_API_TOKEN").ok().filter(|s| !s.is_empty()).or_else(|| string_field("token"))
    };

    let state = app.state::<RemoteMcpState>();
    if let Err(err) = spawn_remote_mcp(
        &app,
        &state,
        StartOptions {
            http_token,
            approval_password,
            port,
            public_hostname,
            vault_root,
            llm_wiki_api_token,
        },
    )
    .await
    {
        eprintln!("[remote-mcp] autostart failed: {err}");
    }
}
