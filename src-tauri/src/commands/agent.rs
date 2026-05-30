//! Agent sidecar subprocess transport.
//!
//! Spawns a Node.js sidecar process that uses the Claude Agent SDK to
//! provide agentic capabilities (tool use, multi-turn, hooks, etc.).
//! Communication is via stdin/stdout JSON-lines, reusing the same
//! emit/listen pattern as claude_cli.rs.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;

use crate::api_server;

/// Shared state holding running agent sidecar processes keyed by stream id.
#[derive(Default)]
pub struct AgentState {
    children: Arc<Mutex<HashMap<String, AgentProcess>>>,
}

struct AgentProcess {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentSandboxOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_allow_bash_if_sandboxed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fail_if_unavailable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSpawnArgs {
    stream_id: String,
    prompt: String,
    system_prompt: Option<String>,
    cwd: Option<String>,
    model: Option<String>,
    max_turns: Option<u32>,
    max_budget_usd: Option<f64>,
    session_id: Option<String>,
    resume: Option<String>,
    continue_session: Option<bool>,
    fork_session: Option<bool>,
    resume_session_at: Option<String>,
    persist_session: Option<bool>,
    title: Option<String>,
    api_key: Option<String>,
    base_url: Option<String>,
    permission_policy: Option<String>,
    project_id: Option<String>,
    project_path: Option<String>,
    api_server_base_url: Option<String>,
    api_token: Option<String>,
    enable_wiki_tools: Option<bool>,
    enable_write_tools: Option<bool>,
    max_write_bytes: Option<u32>,
    max_files_changed: Option<u32>,
    enable_file_checkpointing: Option<bool>,
    // PR D: structured output
    output_format: Option<Value>,

    // PR D: thinking / effort / taskBudget
    thinking: Option<Value>,
    effort: Option<String>,
    task_budget: Option<Value>,

    // PR D: event passthrough
    include_partial_messages: Option<bool>,
    include_hook_events: Option<bool>,
    prompt_suggestions: Option<bool>,
    agent_progress_summaries: Option<bool>,
    forward_subagent_text: Option<bool>,
    sandbox: Option<AgentSandboxOptions>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentRequestOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    system_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_turns: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_budget_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    resume: Option<String>,
    #[serde(rename = "continue", skip_serializing_if = "Option::is_none")]
    continue_session: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fork_session: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    resume_session_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    permission_policy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    api_server_base_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    api_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    enable_wiki_tools: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    enable_write_tools: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_write_bytes: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_files_changed: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    enable_file_checkpointing: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sandbox: Option<AgentSandboxOptions>,
    // PR D: structured output
    #[serde(skip_serializing_if = "Option::is_none")]
    output_format: Option<Value>,

    // PR D: thinking / effort / taskBudget
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    task_budget: Option<Value>,

    // PR D: event passthrough
    #[serde(skip_serializing_if = "Option::is_none")]
    include_partial_messages: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    include_hook_events: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    prompt_suggestions: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_progress_summaries: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    forward_subagent_text: Option<bool>,
    persist_session: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentRequest {
    r#type: &'static str,
    stream_id: String,
    prompt: String,
    options: AgentRequestOptions,
}

fn build_agent_request(args: AgentSpawnArgs) -> AgentRequest {
    AgentRequest {
        r#type: "query",
        stream_id: args.stream_id,
        prompt: args.prompt,
        options: AgentRequestOptions {
            system_prompt: args.system_prompt,
            cwd: args.cwd,
            model: args.model,
            max_turns: args.max_turns,
            max_budget_usd: args.max_budget_usd,
            session_id: args.session_id,
            resume: args.resume,
            continue_session: args.continue_session,
            fork_session: args.fork_session,
            resume_session_at: args.resume_session_at,
            title: args.title,
            api_key: args.api_key,
            base_url: args.base_url,
            permission_policy: args.permission_policy,
            project_id: args.project_id,
            project_path: args.project_path,
            api_server_base_url: args.api_server_base_url,
            api_token: args.api_token,
            enable_wiki_tools: args.enable_wiki_tools,
            enable_write_tools: args.enable_write_tools,
            max_write_bytes: args.max_write_bytes,
            max_files_changed: args.max_files_changed,
            enable_file_checkpointing: args.enable_file_checkpointing,
            sandbox: args.sandbox,
            // PR D: structured output
            output_format: args.output_format,
            // PR D: thinking / effort / taskBudget
            thinking: args.thinking,
            effort: args.effort,
            task_budget: args.task_budget,
            // PR D: event passthrough
            include_partial_messages: args.include_partial_messages,
            include_hook_events: args.include_hook_events,
            prompt_suggestions: args.prompt_suggestions,
            agent_progress_summaries: args.agent_progress_summaries,
            forward_subagent_text: args.forward_subagent_text,
            persist_session: args.persist_session.unwrap_or(false),
        },
    }
}

fn inject_internal_api_token(args: &mut AgentSpawnArgs) -> Option<String> {
    if args.enable_wiki_tools != Some(false) && args.project_path.is_some() {
        let token = api_server::new_agent_internal_api_token();
        args.api_token = Some(token.clone());
        return Some(token);
    }
    None
}

#[tauri::command]
pub async fn agent_spawn(
    app: AppHandle,
    state: State<'_, AgentState>,
    mut args: AgentSpawnArgs,
) -> Result<(), String> {
    eprintln!(
        "[agent_spawn] stream_id={}, model={:?}, base_url={:?}",
        args.stream_id, args.model, args.base_url
    );
    let sidecar_cmd = find_sidecar_command()?;

    let mut cmd = Command::new(&sidecar_cmd[0]);
    if sidecar_cmd.len() > 1 {
        cmd.args(&sidecar_cmd[1..]);
    }

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn agent sidecar: {e}"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Missing stdin handle".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Missing stdout handle".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Missing stderr handle".to_string())?;

    let stream_id = args.stream_id.clone();
    let internal_api_token = inject_internal_api_token(&mut args);
    let request = build_agent_request(args);
    let request_line = format!(
        "{}\n",
        serde_json::to_string(&request)
            .map_err(|e| format!("Failed to serialize agent request: {e}"))?
    );
    if let Some(token) = &internal_api_token {
        api_server::register_agent_internal_api_token(token);
    }
    let stdin = Arc::new(Mutex::new(stdin));
    {
        let mut stdin_guard = stdin.lock().await;
        if let Err(e) = stdin_guard.write_all(request_line.as_bytes()).await {
            if let Some(token) = &internal_api_token {
                api_server::revoke_agent_internal_api_token(token);
            }
            return Err(format!("Failed to write to sidecar stdin: {e}"));
        }
        if let Err(e) = stdin_guard.flush().await {
            if let Some(token) = &internal_api_token {
                api_server::revoke_agent_internal_api_token(token);
            }
            return Err(format!("Failed to flush sidecar stdin: {e}"));
        }
    }

    state.children.lock().await.insert(
        stream_id.clone(),
        AgentProcess {
            child,
            stdin: Arc::clone(&stdin),
        },
    );

    let children = Arc::clone(&state.children);
    let app_for_task = app.clone();
    let stream_id_task = stream_id.clone();
    let internal_api_token_task = internal_api_token.clone();
    let topic = format!("agent:{stream_id}");
    let done_topic = format!("agent:{stream_id}:done");

    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        let mut stderr_reader = BufReader::new(stderr).lines();

        let stderr_task = tokio::spawn(async move {
            let mut collected = String::new();
            while let Ok(Some(line)) = stderr_reader.next_line().await {
                eprintln!("[agent-sidecar stderr] {line}");
                collected.push_str(&line);
                collected.push('\n');
            }
            collected
        });

        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app_for_task.emit(&topic, &line);
        }

        let stderr_output = stderr_task.await.unwrap_or_default();

        let exit_code = {
            let mut map = children.lock().await;
            if let Some(mut process) = map.remove(&stream_id_task) {
                match process.child.try_wait() {
                    Ok(Some(status)) => status.code().unwrap_or(-1),
                    Ok(None) => {
                        let _ = process.child.kill().await;
                        -1
                    }
                    Err(_) => -1,
                }
            } else {
                0
            }
        };

        if let Some(token) = internal_api_token_task {
            api_server::revoke_agent_internal_api_token(&token);
        }

        let done_payload = serde_json::json!({
            "code": exit_code,
            "stderr": stderr_output,
        });
        let _ = app_for_task.emit(&done_topic, &done_payload);
    });

    Ok(())
}

#[tauri::command]
pub async fn agent_tool_response(
    state: State<'_, AgentState>,
    stream_id: String,
    request_id: String,
    ok: bool,
    data: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    let stdin = {
        let map = state.children.lock().await;
        map.get(&stream_id)
            .map(|process| Arc::clone(&process.stdin))
            .ok_or_else(|| format!("No running agent stream: {stream_id}"))?
    };
    let line = serde_json::json!({
        "type": "app_tool_response",
        "streamId": stream_id,
        "requestId": request_id,
        "ok": ok,
        "data": data,
        "error": error,
    })
    .to_string()
        + "\n";
    let mut guard = stdin.lock().await;
    guard
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("Failed to write app tool response: {e}"))?;
    guard
        .flush()
        .await
        .map_err(|e| format!("Failed to flush app tool response: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn agent_permission_response(
    state: State<'_, AgentState>,
    stream_id: String,
    request_id: String,
    ok: bool,
    decision: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    let stdin = {
        let map = state.children.lock().await;
        map.get(&stream_id)
            .map(|process| Arc::clone(&process.stdin))
            .ok_or_else(|| format!("No running agent stream: {stream_id}"))?
    };
    let line = serde_json::json!({
        "type": "permission_response",
        "streamId": stream_id,
        "requestId": request_id,
        "ok": ok,
        "decision": decision,
        "error": error,
    })
    .to_string()
        + "\n";
    let mut guard = stdin.lock().await;
    guard
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("Failed to write permission response: {e}"))?;
    guard
        .flush()
        .await
        .map_err(|e| format!("Failed to flush permission response: {e}"))?;
    Ok(())
}


#[tauri::command]
pub async fn agent_rewind_files(
    state: State<'_, AgentState>,
    stream_id: String,
    message_id: Option<String>,
) -> Result<(), String> {
    let stdin = {
        let map = state.children.lock().await;
        map.get(&stream_id)
            .map(|process| Arc::clone(&process.stdin))
            .ok_or_else(|| format!("No running agent stream: {stream_id}"))?
    };
    let line = serde_json::json!({
        "type": "rewind_files",
        "streamId": stream_id,
        "messageId": message_id,
    })
    .to_string()
        + "\n";
    let mut guard = stdin.lock().await;
    guard
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("Failed to write rewind request: {e}"))?;
    guard
        .flush()
        .await
        .map_err(|e| format!("Failed to flush rewind request: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn agent_request_serializes_checkpoint_and_sandbox_options() {
        let mut args = args_with_optional_fields_none();
        args.enable_file_checkpointing = Some(true);
        args.sandbox = Some(AgentSandboxOptions {
            enabled: Some(true),
            auto_allow_bash_if_sandboxed: Some(false),
            fail_if_unavailable: Some(true),
            network: None,
        });

        let request = build_agent_request(args);
        let value: Value = serde_json::to_value(request).unwrap();
        let options = value.get("options").unwrap();

        assert_eq!(
            options.get("enableFileCheckpointing").and_then(Value::as_bool),
            Some(true)
        );
        let sandbox = options.get("sandbox").unwrap();
        assert_eq!(sandbox.get("enabled").and_then(Value::as_bool), Some(true));
        assert_eq!(
            sandbox.get("autoAllowBashIfSandboxed").and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            sandbox.get("failIfUnavailable").and_then(Value::as_bool),
            Some(true)
        );
        assert!(sandbox.get("network").is_none());
    }

    #[test]
    fn agent_request_omits_absent_checkpoint_and_sandbox() {
        let args = args_with_optional_fields_none();
        let request = build_agent_request(args);
        let value: Value = serde_json::to_value(request).unwrap();
        let options = value.get("options").unwrap();

        assert!(options.get("enableFileCheckpointing").is_none());
        assert!(options.get("sandbox").is_none());
    }

    use super::*;
    use serde_json::Value;

    fn args_with_optional_fields_none() -> AgentSpawnArgs {
        AgentSpawnArgs {
            stream_id: "stream-1".to_string(),
            prompt: "hello".to_string(),
            system_prompt: None,
            cwd: None,
            model: None,
            max_turns: None,
            max_budget_usd: None,
            session_id: None,
            resume: None,
            continue_session: None,
            fork_session: None,
            resume_session_at: None,
            persist_session: None,
            title: None,
            api_key: None,
            base_url: None,
            permission_policy: None,
            project_id: None,
            project_path: None,
            api_server_base_url: None,
            api_token: None,
            enable_wiki_tools: None,
            enable_write_tools: None,
            max_write_bytes: None,
            max_files_changed: None,
            enable_file_checkpointing: None,
            output_format: None,
            thinking: None,
            effort: None,
            task_budget: None,
            include_partial_messages: None,
            include_hook_events: None,
            prompt_suggestions: None,
            agent_progress_summaries: None,
            forward_subagent_text: None,
            sandbox: None,
        }
    }

    #[test]
    fn agent_request_omits_absent_optional_fields() {
        let request = build_agent_request(args_with_optional_fields_none());
        let value: Value = serde_json::to_value(request).unwrap();
        let options = value.get("options").unwrap();

        assert_eq!(value.get("type").and_then(Value::as_str), Some("query"));
        assert_eq!(
            value.get("streamId").and_then(Value::as_str),
            Some("stream-1")
        );
        assert_eq!(
            options.get("persistSession").and_then(Value::as_bool),
            Some(false)
        );
        assert!(options.get("cwd").is_none());
        assert!(options.get("maxBudgetUsd").is_none());
        assert!(options.get("sessionId").is_none());
        assert!(options.get("resume").is_none());
        assert!(options.get("continue").is_none());
        assert!(options.get("forkSession").is_none());
        assert!(options.get("resumeSessionAt").is_none());
        assert!(options.get("title").is_none());
        assert!(options.get("apiKey").is_none());
    }

    #[test]
    fn agent_request_serializes_present_optional_fields_as_camel_case() {
        let mut args = args_with_optional_fields_none();
        args.system_prompt = Some("system".to_string());
        args.cwd = Some("/tmp/wiki".to_string());
        args.model = Some("claude-sonnet-4-20250514".to_string());
        args.max_turns = Some(3);
        args.max_budget_usd = Some(0.25);
        args.session_id = Some("11111111-1111-4111-8111-111111111111".to_string());
        args.resume = Some("22222222-2222-4222-8222-222222222222".to_string());
        args.continue_session = Some(true);
        args.fork_session = Some(true);
        args.resume_session_at = Some("msg-1".to_string());
        args.persist_session = Some(true);
        args.title = Some("Wiki Agent".to_string());
        args.api_key = Some("test-key".to_string());
        args.base_url = Some("http://localhost:4000".to_string());
        args.permission_policy = Some("default".to_string());
        args.project_id = Some("project-1".to_string());
        args.project_path = Some("/tmp/wiki".to_string());
        args.api_server_base_url = Some("http://127.0.0.1:19828".to_string());
        args.api_token = Some("api-token".to_string());
        args.enable_wiki_tools = Some(true);
        args.enable_write_tools = Some(true);
        args.max_write_bytes = Some(262144);
        args.max_files_changed = Some(3);

        let request = build_agent_request(args);
        let value: Value = serde_json::to_value(request).unwrap();
        let options = value.get("options").unwrap();

        assert_eq!(
            options.get("systemPrompt").and_then(Value::as_str),
            Some("system")
        );
        assert_eq!(
            options.get("cwd").and_then(Value::as_str),
            Some("/tmp/wiki")
        );
        assert_eq!(options.get("maxTurns").and_then(Value::as_u64), Some(3));
        assert_eq!(
            options.get("maxBudgetUsd").and_then(Value::as_f64),
            Some(0.25)
        );
        assert_eq!(
            options.get("sessionId").and_then(Value::as_str),
            Some("11111111-1111-4111-8111-111111111111")
        );
        assert_eq!(
            options.get("resume").and_then(Value::as_str),
            Some("22222222-2222-4222-8222-222222222222")
        );
        assert_eq!(options.get("continue").and_then(Value::as_bool), Some(true));
        assert_eq!(
            options.get("forkSession").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            options.get("resumeSessionAt").and_then(Value::as_str),
            Some("msg-1")
        );
        assert_eq!(
            options.get("persistSession").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            options.get("title").and_then(Value::as_str),
            Some("Wiki Agent")
        );
        assert_eq!(
            options.get("baseUrl").and_then(Value::as_str),
            Some("http://localhost:4000")
        );
        assert_eq!(
            options.get("permissionPolicy").and_then(Value::as_str),
            Some("default")
        );
        assert_eq!(
            options.get("projectId").and_then(Value::as_str),
            Some("project-1")
        );
        assert_eq!(
            options.get("projectPath").and_then(Value::as_str),
            Some("/tmp/wiki")
        );
        assert_eq!(
            options.get("apiServerBaseUrl").and_then(Value::as_str),
            Some("http://127.0.0.1:19828")
        );
        assert_eq!(
            options.get("apiToken").and_then(Value::as_str),
            Some("api-token")
        );
        assert_eq!(
            options.get("enableWikiTools").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            options.get("enableWriteTools").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            options.get("maxWriteBytes").and_then(Value::as_u64),
            Some(262144)
        );
        assert_eq!(
            options.get("maxFilesChanged").and_then(Value::as_u64),
            Some(3)
        );
    }

    #[test]
    fn agent_wiki_tools_use_internal_api_token() {
        let mut args = args_with_optional_fields_none();
        args.project_path = Some("/tmp/wiki".to_string());
        args.api_token = Some("user-configured-token".to_string());
        args.enable_wiki_tools = Some(true);

        let token = inject_internal_api_token(&mut args).unwrap();

        assert_eq!(args.api_token.as_deref(), Some(token.as_str()));
        assert_ne!(args.api_token.as_deref(), Some("user-configured-token"));
        api_server::revoke_agent_internal_api_token(&token);
    }

    #[test]
    fn agent_without_wiki_tools_does_not_receive_internal_api_token() {
        let mut args = args_with_optional_fields_none();
        args.project_path = Some("/tmp/wiki".to_string());
        args.enable_wiki_tools = Some(false);

        let token = inject_internal_api_token(&mut args);

        assert!(token.is_none());
        assert!(args.api_token.is_none());
    }
}

#[tauri::command]
pub async fn agent_kill(state: State<'_, AgentState>, stream_id: String) -> Result<(), String> {
    if let Some(mut process) = state.children.lock().await.remove(&stream_id) {
        process
            .child
            .start_kill()
            .map_err(|e| format!("Failed to kill agent sidecar: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn agent_detect() -> Result<bool, String> {
    which::which("node")
        .map(|_| true)
        .map_err(|e| e.to_string())
}

fn find_sidecar_command() -> Result<Vec<String>, String> {
    #[cfg(debug_assertions)]
    {
        let sidecar_entry = std::env::current_dir()
            .map(|d| d.join("sidecar/dist/main.js"))
            .map_err(|e| format!("Cannot resolve sidecar path: {e}"))?;

        if !sidecar_entry.exists() {
            return Err(
                "Agent sidecar dist missing; run `npm --prefix src-tauri/sidecar run build` first"
                    .to_string(),
            );
        }

        Ok(vec![
            "node".to_string(),
            sidecar_entry.to_string_lossy().to_string(),
        ])
    }

    #[cfg(not(debug_assertions))]
    {
        Err("Agent sidecar not available in release mode yet".to_string())
    }
}
