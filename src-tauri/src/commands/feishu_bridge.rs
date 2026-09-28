//! 飞书遥控对话桥接：飞书消息 → 进程内调用 Agent → bot 回发。
//!
//! 设计约束（用户明确要求，2026-09-28）：
//! - **AI 链路一行不改**：直接复用前端聊天走的同一个 `crate::agent_start_turn`，
//!   不碰 HTTP API、不改 AgentRuntime、不加 token 假设。
//! - **常驻不卡顿**：`lark-cli event consume` 阻塞在 websocket 读，CPU 占用≈0；
//!   解析与 AI 调用放在独立 task，读循环不被阻塞。
//! - **单例**：同一时刻只允许一个 consume 进程，避免重复消费同一条消息。
//!
//! 会话隔离：飞书会话用 `feishu_{chat_id}` 作 session_id，落到后端
//! AgentSessionStore，与前端 UI 会话互不干扰，但天然支持多轮上下文。

use std::collections::HashSet;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, Mutex};

use super::feishu::{find_lark_cli, send_feishu_text, strip_lark_env};

/// 回发飞书的单条文本上限（字符）。飞书文本消息体量大易被截断，保守取 3500。
const MAX_REPLY_CHARS: usize = 3500;
/// 子进程异常退出后的重连间隔。
const RECONNECT_DELAY: Duration = Duration::from_secs(5);
/// 已处理 event_id 的保留上限，超出即整体清空（防止内存无界增长）。
const DEDUP_CAPACITY: usize = 1000;

/// 一条解析后的入站飞书消息。
#[derive(Debug, Clone)]
struct FeishuInbound {
    event_id: String,
    chat_id: String,
    sender_id: String,
    content: String,
}

/// 桥接运行状态，序列化给设置页展示。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatus {
    /// 用户是否已启用（stop 后为 false）。
    pub running: bool,
    /// consume 子进程是否已发出 `[event] ready` 标记。
    pub ready: bool,
    /// 已成功处理并回发的消息条数。
    pub handled: u64,
    /// 最近一次错误（空表示无）。
    pub last_error: String,
    /// 最近一条入站消息的摘要，便于确认链路活着。
    pub last_message: String,
    /// 回复时使用的项目（默认 "current"）。
    pub project_id: String,
}

/// 桥接共享状态。全部字段是 Arc，可自由 clone 进各 task。
#[derive(Default, Clone)]
pub struct FeishuBridgeState {
    running: Arc<AtomicBool>,
    status: Arc<Mutex<BridgeStatus>>,
    child: Arc<Mutex<Option<Child>>>,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
}

impl FeishuBridgeState {
    pub async fn snapshot(&self) -> BridgeStatus {
        let mut status = self.status.lock().await.clone();
        status.running = self.running.load(Ordering::SeqCst);
        status
    }

    /// 应用退出前调用，确保不留孤儿子进程。
    pub async fn shutdown(&self) {
        stop_inner(self).await;
    }
}

/// 停掉当前实例。
///
/// 关键：consume 会派生 `event _bus` 孙进程持有真正的飞书长连接。
/// Windows 上杀父进程不杀子，若只 kill consume，孤儿 bus 会继续占用
/// 连接，导致下一次启动的 consume 永远连不上（2026-09-28 实测踩坑）。
/// 因此 Windows 下用 `taskkill /T /F` 整树终止。
async fn stop_inner(state: &FeishuBridgeState) {
    state.running.store(false, Ordering::SeqCst);
    state.stdin.lock().await.take();
    if let Some(mut child) = state.child.lock().await.take() {
        let pid = child.id();
        #[cfg(target_os = "windows")]
        if let Some(pid) = pid.filter(|p| *p > 0) {
            let _ = tokio::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .await;
        }
        // 兜底 + 回收，避免僵尸句柄。
        let _ = child.start_kill();
        let _ = child.wait().await;
    }
    let mut status = state.status.lock().await;
    status.ready = false;
}

/// 从 consume 输出的一行 NDJSON 解析入站消息；非文本/无用行返回 None。
fn parse_inbound(line: &str) -> Option<FeishuInbound> {
    let trimmed = line.trim();
    if !trimmed.starts_with('{') {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(trimmed).ok()?;
    // 只处理文本消息；interactive 卡片的 content 是原始 JSON，跳过。
    let message_type = value
        .get("message_type")
        .and_then(|v| v.as_str())
        .unwrap_or("text");
    if message_type != "text" {
        return None;
    }
    let content = value
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if content.is_empty() {
        return None;
    }
    let chat_id = value
        .get("chat_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if chat_id.is_empty() {
        return None;
    }
    Some(FeishuInbound {
        event_id: value
            .get("event_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        chat_id,
        sender_id: value
            .get("sender_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        content,
    })
}

/// 读取 consume 的 stdout，逐行解析后投递到 worker。
async fn pump_stdout(stdout: ChildStdout, tx: mpsc::Sender<FeishuInbound>) {
    let mut lines = BufReader::new(stdout).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                if let Some(msg) = parse_inbound(&line) {
                    if tx.send(msg).await.is_err() {
                        break;
                    }
                }
            }
            Ok(None) => break,
            Err(_) => break,
        }
    }
}

/// 读取 stderr：检测 ready 标记与退出原因，写入状态供前端展示。
async fn pump_stderr(
    stderr: tokio::process::ChildStderr,
    state: FeishuBridgeState,
) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.contains("[event] ready") {
            state.status.lock().await.ready = true;
        }
        if line.contains("[event] exited") {
            state.status.lock().await.ready = false;
        }
        // lark-cli 的告警/错误行保留到 last_error，便于排查断链。
        if line.contains("error") || line.contains("WARN") || line.contains("denied") {
            state.status.lock().await.last_error = line.trim().to_string();
        }
    }
}

/// 常驻 supervisor：拉起 consume 子进程，读到 EOF 后按需重连。
async fn consume_supervisor(state: FeishuBridgeState, tx: mpsc::Sender<FeishuInbound>) {
    let Some(cli) = find_lark_cli() else {
        state.status.lock().await.last_error = "lark-cli.exe not found".to_string();
        return;
    };
    loop {
        if !state.running.load(Ordering::SeqCst) {
            break;
        }
        let mut cmd = strip_lark_env(Command::new(&cli));
        cmd.arg("event")
            .arg("consume")
            .arg("im.message.receive_v1")
            .arg("--as")
            .arg("bot")
            // stdin 保持 piped 且不关闭：consume 把 stdin EOF 当退出信号，
            // 这里持有句柄等于永不 EOF，保证常驻。
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = match cmd.spawn() {
            Ok(child) => child,
            Err(err) => {
                state.status.lock().await.last_error = format!("spawn lark-cli failed: {err}");
                tokio::time::sleep(RECONNECT_DELAY).await;
                continue;
            }
        };
        *state.stdin.lock().await = child.stdin.take();
        if let Some(stderr) = child.stderr.take() {
            let stderr_state = state.clone();
            tauri::async_runtime::spawn(async move { pump_stderr(stderr, stderr_state).await });
        }
        let stdout = child.stdout.take();
        *state.child.lock().await = Some(child);

        if let Some(stdout) = stdout {
            pump_stdout(stdout, tx.clone()).await;
        }

        // 子进程已退出：清理句柄，判断是否需要重连。
        if let Some(mut child) = state.child.lock().await.take() {
            let _ = child.wait().await;
        }
        state.stdin.lock().await.take();
        state.status.lock().await.ready = false;

        if !state.running.load(Ordering::SeqCst) {
            break;
        }
        state.status.lock().await.last_error =
            "consume exited unexpectedly, reconnecting…".to_string();
        tokio::time::sleep(RECONNECT_DELAY).await;
    }
}

/// 截断超长回复，避免飞书消息体过大。
fn truncate_reply(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= MAX_REPLY_CHARS {
        return trimmed.to_string();
    }
    let head: String = trimmed.chars().take(MAX_REPLY_CHARS).collect();
    format!("{head}\n…（内容过长已截断）")
}

/// 串行处理入站消息：去重 → 调 Agent（复用 agent_start_turn）→ 回发。
async fn worker(
    state: FeishuBridgeState,
    app: tauri::AppHandle,
    project_id: String,
    mut rx: mpsc::Receiver<FeishuInbound>,
) {
    let mut seen: HashSet<String> = HashSet::new();
    while let Some(msg) = rx.recv().await {
        if !state.running.load(Ordering::SeqCst) {
            break;
        }
        // 去重：同一 event 只处理一次（重连窗口内可能重复投递）。
        if !msg.event_id.is_empty() {
            if !seen.insert(msg.event_id.clone()) {
                continue;
            }
            if seen.len() > DEDUP_CAPACITY {
                seen.clear();
                seen.insert(msg.event_id.clone());
            }
        }
        state.status.lock().await.last_message =
            format!("{}: {}", msg.sender_id, truncate_reply(&msg.content));
        state.status.lock().await.last_error = String::new();

        let reply = match run_agent(&app, &project_id, &msg).await {
            Ok(text) => text,
            Err(err) => {
                state.status.lock().await.last_error = err.clone();
                format!("[LLM Wiki] 处理失败: {err}")
            }
        };
        let text = if reply.trim().is_empty() {
            "[LLM Wiki] 本轮没有产生文本回复".to_string()
        } else {
            truncate_reply(&reply)
        };
        let sent = send_feishu_text(&msg.chat_id, &text).await;
        if sent.ok {
            state.status.lock().await.handled += 1;
        } else {
            state.status.lock().await.last_error = sent.error;
        }
    }
}

/// 进程内复用前端聊天的同一个入口。AI 链路零改动。
async fn run_agent(
    app: &tauri::AppHandle,
    project_id: &str,
    msg: &FeishuInbound,
) -> Result<String, String> {
    // 借 serde 默认值构造请求，字段取值与前端一致（wiki 工具开、标准模式）。
    let request: crate::agent::AgentChatRequest = serde_json::from_value(serde_json::json!({
        "message": msg.content,
        "sessionId": format!("feishu_{}", msg.chat_id),
        "persistSession": true,
    }))
    .map_err(|err| format!("build request failed: {err}"))?;
    let response = crate::agent_start_turn(app.clone(), project_id.to_string(), request, None).await?;
    Ok(response.message)
}

#[tauri::command]
pub async fn feishu_bridge_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, FeishuBridgeState>,
    project_id: Option<String>,
) -> Result<BridgeStatus, String> {
    let state = state.inner().clone();
    Ok(start_bridge(&state, &app, project_id.as_deref().unwrap_or("current")).await)
}

/// 实际启动逻辑：命令与开机自恢复共用。
async fn start_bridge(state: &FeishuBridgeState, app: &tauri::AppHandle, project: &str) -> BridgeStatus {
    // 单例：先停掉可能存在的旧实例，避免两个 consume 重复消费。
    stop_inner(state).await;
    state.running.store(true, Ordering::SeqCst);
    let project = project.to_string();
    {
        let mut status = state.status.lock().await;
        *status = BridgeStatus {
            project_id: project.clone(),
            ..Default::default()
        };
    }

    let (tx, rx) = mpsc::channel(64);
    let worker_state = state.clone();
    let worker_app = app.clone();
    let worker_project = project.clone();
    tauri::async_runtime::spawn(async move {
        worker(worker_state, worker_app, worker_project, rx).await;
    });
    let consume_state = state.clone();
    tauri::async_runtime::spawn(async move {
        consume_supervisor(consume_state, tx).await;
    });

    state.snapshot().await
}

/// 应用启动时调用（lib.rs setup 里 spawn）：
/// `feishuConfig.bridgeEnabled=true` 则自动恢复桥接，无需用户手动保存设置。
/// 延迟 2s 等 setup 阶段各状态就绪。
pub async fn autostart_if_enabled(app: &tauri::AppHandle) {
    use tauri::Manager;
    tokio::time::sleep(Duration::from_secs(2)).await;
    let Some(state) = app.try_state::<FeishuBridgeState>() else {
        return;
    };
    let state = state.inner().clone();
    if state.running.load(Ordering::SeqCst) {
        return; // 已在跑（例如前端保存触发）
    }
    let enabled = crate::api_server::load_app_state(app)
        .and_then(|v| {
            v.get("feishuConfig")
                .and_then(|c| c.get("bridgeEnabled"))
                .and_then(|b| b.as_bool())
        })
        .unwrap_or(false);
    if !enabled {
        return;
    }
    start_bridge(&state, app, "current").await;
}

#[tauri::command]
pub async fn feishu_bridge_stop(
    state: tauri::State<'_, FeishuBridgeState>,
) -> Result<BridgeStatus, String> {
    let state = state.inner().clone();
    stop_inner(&state).await;
    Ok(state.snapshot().await)
}

#[tauri::command]
pub async fn feishu_bridge_status(
    state: tauri::State<'_, FeishuBridgeState>,
) -> Result<BridgeStatus, String> {
    Ok(state.snapshot().await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_text_event() {
        let line = r#"{"event_id":"e1","chat_id":"oc_abc","chat_type":"p2p","sender_id":"ou_xyz","content":"你好"}"#;
        let msg = parse_inbound(line).expect("should parse");
        assert_eq!(msg.event_id, "e1");
        assert_eq!(msg.chat_id, "oc_abc");
        assert_eq!(msg.sender_id, "ou_xyz");
        assert_eq!(msg.content, "你好");
    }

    #[test]
    fn skips_non_text_and_noise() {
        assert!(parse_inbound("[event] ready event_key=im.message.receive_v1").is_none());
        assert!(parse_inbound(
            r#"{"chat_id":"oc_abc","message_type":"interactive","content":"{\"a\":1}"}"#
        )
        .is_none());
        assert!(parse_inbound(r#"{"chat_id":"oc_abc","content":"   "}"#).is_none());
    }

    #[test]
    fn truncates_long_reply() {
        let long = "字".repeat(MAX_REPLY_CHARS + 10);
        let out = truncate_reply(&long);
        assert!(out.ends_with("（内容过长已截断）"));
        assert!(out.chars().count() < long.chars().count());
    }
}
