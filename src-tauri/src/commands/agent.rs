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
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

/// Shared state holding running agent sidecar processes keyed by stream id.
#[derive(Default)]
pub struct AgentState {
    children: Arc<Mutex<HashMap<String, Child>>>,
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
    api_key: Option<String>,
    base_url: Option<String>,
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
    api_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    base_url: Option<String>,
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
            api_key: args.api_key,
            base_url: args.base_url,
            persist_session: false,
        },
    }
}

#[tauri::command]
pub async fn agent_spawn(
    app: AppHandle,
    state: State<'_, AgentState>,
    args: AgentSpawnArgs,
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

    let mut stdin = child
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
    let request = build_agent_request(args);
    stdin
        .write_all(
            format!(
                "{}\n",
                serde_json::to_string(&request)
                    .map_err(|e| format!("Failed to serialize agent request: {e}"))?
            )
            .as_bytes(),
        )
        .await
        .map_err(|e| format!("Failed to write to sidecar stdin: {e}"))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("Failed to flush sidecar stdin: {e}"))?;
    drop(stdin);

    state.children.lock().await.insert(stream_id.clone(), child);

    let children = Arc::clone(&state.children);
    let app_for_task = app.clone();
    let stream_id_task = stream_id.clone();
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
            if let Some(mut child) = map.remove(&stream_id_task) {
                match child.try_wait() {
                    Ok(Some(status)) => status.code().unwrap_or(-1),
                    Ok(None) => {
                        let _ = child.kill().await;
                        -1
                    }
                    Err(_) => -1,
                }
            } else {
                0
            }
        };

        let done_payload = serde_json::json!({
            "code": exit_code,
            "stderr": stderr_output,
        });
        let _ = app_for_task.emit(&done_topic, &done_payload);
    });

    Ok(())
}

#[cfg(test)]
mod tests {
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
            api_key: None,
            base_url: None,
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
        args.api_key = Some("test-key".to_string());
        args.base_url = Some("http://localhost:4000".to_string());

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
            options.get("baseUrl").and_then(Value::as_str),
            Some("http://localhost:4000")
        );
    }
}

#[tauri::command]
pub async fn agent_kill(state: State<'_, AgentState>, stream_id: String) -> Result<(), String> {
    if let Some(mut child) = state.children.lock().await.remove(&stream_id) {
        child
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
        let sidecar_dir = std::env::current_dir()
            .map(|d| d.join("sidecar/src/main.ts"))
            .map_err(|e| format!("Cannot resolve sidecar path: {e}"))?;

        Ok(vec![
            "node".to_string(),
            "--experimental-strip-types".to_string(),
            sidecar_dir.to_string_lossy().to_string(),
        ])
    }

    #[cfg(not(debug_assertions))]
    {
        Err("Agent sidecar not available in release mode yet".to_string())
    }
}
