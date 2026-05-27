//! Agent sidecar subprocess transport.
//!
//! Spawns a Node.js sidecar process that uses the Claude Agent SDK to
//! provide agentic capabilities (tool use, multi-turn, hooks, etc.).
//! Communication is via stdin/stdout JSON-lines, reusing the same
//! emit/listen pattern as claude_cli.rs.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

/// Shared state holding running agent sidecar processes keyed by stream id.
#[derive(Default)]
pub struct AgentState {
    children: Arc<Mutex<HashMap<String, Child>>>,
}

#[tauri::command]
pub async fn agent_spawn(
    app: AppHandle,
    state: State<'_, AgentState>,
    stream_id: String,
    prompt: String,
    system_prompt: Option<String>,
    cwd: Option<String>,
    model: Option<String>,
    max_turns: Option<u32>,
    max_budget_usd: Option<f64>,
    api_key: Option<String>,
    base_url: Option<String>,
) -> Result<(), String> {
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

    let request = serde_json::json!({
        "type": "query",
        "streamId": stream_id,
        "prompt": prompt,
        "options": {
            "systemPrompt": system_prompt,
            "cwd": cwd,
            "model": model,
            "maxTurns": max_turns,
            "maxBudgetUsd": max_budget_usd,
            "apiKey": api_key,
            "baseUrl": base_url,
            "persistSession": false,
        }
    });
    stdin
        .write_all(format!("{}\n", request).as_bytes())
        .await
        .map_err(|e| format!("Failed to write to sidecar stdin: {e}"))?;
    stdin
        .flush()
        .await
        .map_err(|e| format!("Failed to flush sidecar stdin: {e}"))?;
    drop(stdin);

    state
        .children
        .lock()
        .await
        .insert(stream_id.clone(), child);

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

        // Remove child from map and get exit code
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

#[tauri::command]
pub async fn agent_kill(
    state: State<'_, AgentState>,
    stream_id: String,
) -> Result<(), String> {
    if let Some(mut child) = state.children.lock().await.remove(&stream_id) {
        child
            .start_kill()
            .map_err(|e| format!("Failed to kill agent sidecar: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub fn agent_detect() -> Result<bool, String> {
    // Check if node is available on PATH
    which::which("node").map(|_| true).map_err(|e| e.to_string())
}

/// Returns the command + args to launch the sidecar.
/// In dev mode: `node --experimental-strip-types <path>/src/main.ts`
/// In release: TBD (bundled binary)
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
