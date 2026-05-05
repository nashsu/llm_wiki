//! Local OAuth-backed CLI transports for providers that do not expose a
//! stable desktop-app OAuth token we should handle directly.
//!
//! GPT uses the official Codex CLI login (`codex login` / ChatGPT OAuth).
//! Gemini / Antigravity uses the official Gemini CLI login path. LLM Wiki
//! never reads or stores their tokens; it only spawns the vendor CLI.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Command as StdCommand, Stdio};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

#[derive(Default)]
pub struct LocalCliState {
    children: Arc<Mutex<HashMap<String, Child>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LocalCliProvider {
    CodexCli,
    GeminiCli,
}

#[derive(Deserialize)]
pub struct LocalCliMessage {
    role: String,
    content: String,
}

#[derive(Serialize)]
pub struct LocalCliDetectResult {
    installed: bool,
    version: Option<String>,
    path: Option<String>,
    auth_status: Option<String>,
    error: Option<String>,
}

fn command_name(provider: &LocalCliProvider) -> &'static str {
    match provider {
        LocalCliProvider::CodexCli => "codex",
        LocalCliProvider::GeminiCli => "gemini",
    }
}

fn find_command(provider: &LocalCliProvider) -> Result<PathBuf, String> {
    which::which(command_name(provider))
        .map_err(|_| format!("`{}` not found on PATH", command_name(provider)))
}

#[tauri::command]
pub async fn local_cli_detect(provider: LocalCliProvider) -> Result<LocalCliDetectResult, String> {
    let path = match find_command(&provider) {
        Ok(p) => p,
        Err(error) => {
            return Ok(LocalCliDetectResult {
                installed: false,
                version: None,
                path: None,
                auth_status: None,
                error: Some(error),
            });
        }
    };
    let path_str = path.to_string_lossy().to_string();

    let version = tokio::time::timeout(
        Duration::from_secs(3),
        Command::new(&path).arg("--version").output(),
    )
    .await
    .ok()
    .and_then(Result::ok)
    .filter(|out| out.status.success())
    .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
    .filter(|s| !s.is_empty());

    let auth_status = match provider {
        LocalCliProvider::CodexCli => {
            let out = tokio::time::timeout(
                Duration::from_secs(3),
                Command::new(&path).args(["login", "status"]).output(),
            )
            .await;
            match out {
                Ok(Ok(out)) => {
                    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                    Some(if stdout.is_empty() { stderr } else { stdout }).filter(|s| !s.is_empty())
                }
                _ => None,
            }
        }
        // Gemini CLI currently exposes login through its interactive UI,
        // but no cheap stable auth-status subcommand.
        LocalCliProvider::GeminiCli => None,
    };

    Ok(LocalCliDetectResult {
        installed: true,
        version,
        path: Some(path_str),
        auth_status,
        error: None,
    })
}

#[tauri::command]
pub async fn local_cli_open_login(provider: LocalCliProvider) -> Result<(), String> {
    let path = find_command(&provider)?;
    let command = match provider {
        LocalCliProvider::CodexCli => {
            format!("{} login", shell_quote(&path.to_string_lossy()))
        }
        LocalCliProvider::GeminiCli => shell_quote(&path.to_string_lossy()),
    };
    open_terminal(&command)
}

fn open_terminal(command: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let script = format!(
            r#"tell application "Terminal"
    activate
    do script "{}"
end tell"#,
            command.replace('\\', "\\\\").replace('"', "\\\"")
        );
        StdCommand::new("osascript")
            .arg("-e")
            .arg(script)
            .spawn()
            .map_err(|e| format!("Failed to open Terminal for OAuth login: {e}"))?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        StdCommand::new("cmd")
            .args(["/C", "start", "", "cmd", "/K", command])
            .spawn()
            .map_err(|e| format!("Failed to open Command Prompt for OAuth login: {e}"))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let command = format!("{command}; exec $SHELL");
        let terminals: [(&str, &[&str]); 4] = [
            ("x-terminal-emulator", &["-e", "sh", "-lc"]),
            ("gnome-terminal", &["--", "sh", "-lc"]),
            ("konsole", &["-e", "sh", "-lc"]),
            ("xterm", &["-e", "sh", "-lc"]),
        ];

        for (terminal, args) in terminals {
            let Ok(path) = which::which(terminal) else {
                continue;
            };
            let mut cmd = StdCommand::new(path);
            cmd.args(args).arg(&command);
            if cmd.spawn().is_ok() {
                return Ok(());
            }
        }

        Err("No supported terminal emulator found. Run the provider CLI in a terminal to complete OAuth login.".to_string())
    }
}

#[tauri::command]
pub async fn local_cli_spawn(
    app: AppHandle,
    state: State<'_, LocalCliState>,
    stream_id: String,
    provider: LocalCliProvider,
    model: String,
    messages: Vec<LocalCliMessage>,
) -> Result<(), String> {
    let exe = find_command(&provider)?;
    let prompt = render_prompt(&messages);
    if prompt.trim().is_empty() {
        return Err("No prompt content to send to local CLI".to_string());
    }

    let mut cmd = Command::new(exe);
    let mut output_file: Option<PathBuf> = None;
    match provider {
        LocalCliProvider::CodexCli => {
            let path = std::env::temp_dir().join(format!("llm-wiki-codex-{stream_id}.txt"));
            cmd.arg("exec")
                .arg("--skip-git-repo-check")
                .arg("--sandbox")
                .arg("read-only")
                .arg("-c")
                .arg("mcp_servers={}")
                .arg("-m")
                .arg(&model)
                .arg("-o")
                .arg(&path)
                .arg(&prompt);
            output_file = Some(path);
        }
        LocalCliProvider::GeminiCli => {
            cmd.arg("--model")
                .arg(&model)
                .arg("--output-format")
                .arg("text")
                .arg(prompt);
        }
    }

    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn local CLI: {e}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Missing stdout handle".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Missing stderr handle".to_string())?;

    state.children.lock().await.insert(stream_id.clone(), child);

    let children = Arc::clone(&state.children);
    let topic = format!("local-cli:{stream_id}");
    let done_topic = format!("local-cli:{stream_id}:done");
    let stream_id_task = stream_id.clone();
    let output_file_task = output_file.clone();

    tokio::spawn(async move {
        let mut stdout_reader = BufReader::new(stdout).lines();
        let mut stderr_reader = BufReader::new(stderr).lines();
        let app_for_stdout = app.clone();
        let topic_for_stdout = topic.clone();

        let stdout_task = tokio::spawn(async move {
            let mut collected = String::new();
            while let Ok(Some(line)) = stdout_reader.next_line().await {
                collected.push_str(&line);
                collected.push('\n');
                let _ = app_for_stdout.emit(&topic_for_stdout, line);
            }
            collected
        });

        let stderr_task = tokio::spawn(async move {
            let mut collected = String::new();
            while let Ok(Some(line)) = stderr_reader.next_line().await {
                eprintln!("[local-cli stderr] {line}");
                collected.push_str(&line);
                collected.push('\n');
            }
            collected
        });

        let child_opt = children.lock().await.remove(&stream_id_task);
        let exit_code = if let Some(mut child) = child_opt {
            match child.wait().await {
                Ok(status) => status.code(),
                Err(_) => None,
            }
        } else {
            None
        };

        let mut stdout_text = stdout_task.await.unwrap_or_default();
        if let Some(path) = output_file_task {
            if let Ok(text) = tokio::fs::read_to_string(&path).await {
                if !text.trim().is_empty() {
                    stdout_text.push_str("\n--- out ---\n");
                    stdout_text.push_str(&text);
                }
            }
            let _ = tokio::fs::remove_file(path).await;
        }
        let stderr_text = stderr_task.await.unwrap_or_default();

        let _ = app.emit(
            &done_topic,
            serde_json::json!({
                "code": exit_code,
                "stdout": stdout_text,
                "stderr": stderr_text,
            }),
        );
    });

    Ok(())
}

#[tauri::command]
pub async fn local_cli_kill(
    state: State<'_, LocalCliState>,
    stream_id: String,
) -> Result<(), String> {
    if let Some(mut child) = state.children.lock().await.remove(&stream_id) {
        let _ = child.start_kill();
    }
    Ok(())
}

fn render_prompt(messages: &[LocalCliMessage]) -> String {
    messages
        .iter()
        .map(|m| format!("{}:\n{}", m.role.to_uppercase(), m.content))
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}
