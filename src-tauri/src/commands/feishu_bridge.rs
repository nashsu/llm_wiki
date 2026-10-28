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
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, Mutex};

use super::feishu::{find_lark_cli, send_feishu_text, strip_lark_env, suppress_windows_console};

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
    /// 是否有消息正在处理（true 时前端可显示进度）。
    pub busy: bool,
    /// 正在处理的消息摘要（busy 时有意义）。
    pub current_message: String,
    /// 当前任务已耗时（秒），busy 时由前端每秒自增展示。
    pub current_elapsed_secs: u64,
    /// 排队等待处理的消息条数。
    pub pending: usize,
    /// 本轮请求注入的 skill id（空表示本模式不用 skill）。
    pub skill_id: String,
    /// 本轮该 skill 是否真的注入成功（id 找不到时为 false）。
    pub skill_applied: bool,
    /// 本轮实际注入的 skill 条数（0 表示没注入）。
    pub skill_count: usize,
}

/// 桥接共享状态。全部字段是 Arc，可自由 clone 进各 task。
#[derive(Default, Clone)]
pub struct FeishuBridgeState {
    running: Arc<AtomicBool>,
    status: Arc<Mutex<BridgeStatus>>,
    child: Arc<Mutex<Option<Child>>>,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    /// 最近一次子进程退出是否由网络/DNS 故障引起（stderr 命中关键行时置位）。
    /// 用于把 `consume exited unexpectedly` 细化为可操作的提示。
    net_error: Arc<AtomicBool>,
    /// 是否有消息正在处理（供前端显示「正在处理 XX」）。
    busy: Arc<AtomicBool>,
    /// 正在处理的消息摘要。
    current_message: Arc<Mutex<String>>,
    /// 当前任务的开始时刻，用于算 elapsed。
    started_at: Arc<Mutex<Option<Instant>>>,
    /// 排队等待处理的消息条数（pump_stdout 入队 +1，worker 开始处理 -1）。
    pending: Arc<AtomicUsize>,
}

impl FeishuBridgeState {
    pub async fn snapshot(&self) -> BridgeStatus {
        let mut status = self.status.lock().await.clone();
        status.running = self.running.load(Ordering::SeqCst);
        status.busy = self.busy.load(Ordering::SeqCst);
        status.current_message = self.current_message.lock().await.clone();
        status.pending = self.pending.load(Ordering::SeqCst);
        status.current_elapsed_secs = self
            .started_at
            .lock()
            .await
            .map(|start| start.elapsed().as_secs())
            .unwrap_or(0);
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
            let mut tk = tokio::process::Command::new("taskkill");
            tk.args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            suppress_windows_console(&mut tk);
            let _ = tk.status().await;
        }
        // 兜底 + 回收，避免僵尸句柄。
        let _ = child.start_kill();
        let _ = child.wait().await;
    }
    let mut status = state.status.lock().await;
    status.ready = false;
    drop(status);
    // 复位进度：停止后 UI 不应残留「正在处理」。
    state.busy.store(false, Ordering::SeqCst);
    state.current_message.lock().await.clear();
    *state.started_at.lock().await = None;
    state.pending.store(0, Ordering::SeqCst);
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
async fn pump_stdout(
    stdout: ChildStdout,
    tx: mpsc::Sender<FeishuInbound>,
    pending: Arc<AtomicUsize>,
) {
    let mut lines = BufReader::new(stdout).lines();
    loop {
        match lines.next_line().await {
            Ok(Some(line)) => {
                if let Some(msg) = parse_inbound(&line) {
                    // 入队计数：worker 取走时 -1，反映当前排队深度。
                    pending.fetch_add(1, Ordering::SeqCst);
                    if tx.send(msg).await.is_err() {
                        pending.fetch_sub(1, Ordering::SeqCst);
                        break;
                    }
                }
            }
            Ok(None) => break,
            Err(_) => break,
        }
    }
}

/// 判断一行 stderr 是否指示网络/DNS 故障（用于细化重连提示）。
fn is_network_error(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    [
        "no such host",
        "lookup ",
        "connection attempt failed",
        "establish connection failed",
        "connection refused",
        "timed out",
        "timeout",
        "network is unreachable",
        "get conn url failed",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
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
        // 网络/DNS 故障标记：退出后据此给出可操作提示（而非笼统的 exited）。
        if is_network_error(&line) {
            state.net_error.store(true, Ordering::SeqCst);
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

        // 新连接开始前清掉上一轮的网络故障标记。
        state.net_error.store(false, Ordering::SeqCst);

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
            pump_stdout(stdout, tx.clone(), state.pending.clone()).await;
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
        // 区分退出原因：网络/DNS 故障给出可操作提示，其余才是真正的异常退出。
        let msg = if state.net_error.load(Ordering::SeqCst) {
            "网络不可达（DNS 解析失败或连接超时），5 秒后重试…"
        } else {
            "consume exited unexpectedly, reconnecting…"
        };
        state.status.lock().await.last_error = msg.to_string();
        tokio::time::sleep(RECONNECT_DELAY).await;
    }
}

/// 截断超长回复，避免飞书消息体过大。
fn truncate_reply(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= MAX_REPLY_CHARS {
        return trimmed.to_string();
    }
    // 后缀本身也要占预算，否则截断后反而比原文更长。
    const SUFFIX: &str = "\n…（内容过长已截断）";
    let budget = MAX_REPLY_CHARS.saturating_sub(SUFFIX.chars().count());
    let head: String = trimmed.chars().take(budget).collect();
    format!("{head}{SUFFIX}")
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
        // 消息已被 worker 取走，队列深度 -1（去重跳过的分支也已离队）。
        state.pending.fetch_sub(1, Ordering::SeqCst);
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

        // 进入处理：置 busy + 记开始时刻，供前端显示「正在处理 XX（已 Ns）」。
        state.busy.store(true, Ordering::SeqCst);
        *state.current_message.lock().await = truncate_reply(&msg.content);
        *state.started_at.lock().await = Some(Instant::now());
        {
            // 上一轮的 skill 结论不能留给本轮，先清空。
            let mut status = state.status.lock().await;
            status.skill_id.clear();
            status.skill_applied = false;
            status.skill_count = 0;
        }

        // 每条消息实时读取文档回复配置（保存设置即生效，无需重启桥接）。
        let feishu_cfg = crate::api_server::load_app_state(&app)
            .and_then(|v| v.get("feishuConfig").cloned())
            .unwrap_or(serde_json::Value::Null);
        let cfg_str = |key: &str| {
            feishu_cfg
                .get(key)
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        };
        // 回复形式：优先读 replyFormat（doc/html/text），缺失时从废弃字段
        // bridgeReplyAsDoc 推导（true→doc，false→text），兜底 doc。
        let reply_format = feishu_cfg
            .get("replyFormat")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| {
                let legacy = feishu_cfg
                    .get("bridgeReplyAsDoc")
                    .and_then(|b| b.as_bool())
                    .unwrap_or(true);
                if legacy { "doc".to_string() } else { "text".to_string() }
            });
        let reply_as_doc = reply_format == "doc";
        let reply_as_html = reply_format == "html";
        let doc_mode = feishu_cfg
            .get("bridgeDocMode")
            .and_then(|v| v.as_str())
            .unwrap_or("new")
            .to_string();
        let doc_target = super::feishu::FeishuDocTarget {
            folder_token: cfg_str("bridgeDocFolder"),
            fixed_doc: cfg_str("bridgeDocTarget"),
            fixed_command: if doc_mode == "append" { "append".into() } else { "overwrite".into() },
        };
        // fixed=整体覆盖固定文档；append=追加到固定文档文末
        let fixed_mode =
            (doc_mode == "fixed" || doc_mode == "append") && !doc_target.fixed_doc.is_empty();

        let reply = match run_agent(&app, &project_id, &msg, &reply_format, &cfg_str("htmlSkillId")).await {
            Ok(result) => {
                state.status.lock().await.skill_id = result.skill_id;
                state.status.lock().await.skill_count = result.skill_count;
                state.status.lock().await.skill_applied = result.skill_count > 0;
                result.text
            }
            Err(err) => {
                state.status.lock().await.last_error = err.clone();
                format!("[LLM Wiki] 处理失败: {err}")
            }
        };

        // HTML 模式：Agent 已按 skill 直接产出单文件 HTML，这里只发文件；
        // 失败或 Agent 没给出 HTML 时降级文档 → 纯文本。
        let sent = if reply_as_html
            && !reply.trim().is_empty()
            && !reply.starts_with("[LLM Wiki]")
            && looks_like_html(&reply)
        {
            let title = doc_title(&msg.content);
            let html = super::feishu::strip_html_fences(&reply);
            let file_name = format!(
                "{}.html",
                title.chars().take(30).collect::<String>().replace(|c: char| {
                    !c.is_alphanumeric() && c != '.' && c != '_' && c != '-'
                }, "_")
            );
            match super::feishu::feishu_send_file(msg.chat_id.clone(), file_name, html).await {
                Ok(f) if f.ok => {
                    // 文件消息不带头，补一条文本说明
                    send_feishu_text(&msg.chat_id, &format!("📄 {title}（HTML 报告）")).await
                }
                Ok(f) => {
                    eprintln!("[feishu-html] send file FAILED: {}", f.error);
                    state.status.lock().await.last_error =
                        format!("html file send failed: {}（已降级）", f.error);
                    fallback_doc_or_text(&msg, &reply, &title, &doc_target, &doc_mode, fixed_mode).await
                }
                Err(err) => {
                    eprintln!("[feishu-html] send file error: {err}");
                    state.status.lock().await.last_error =
                        format!("html file send error: {err}（已降级）");
                    fallback_doc_or_text(&msg, &reply, &title, &doc_target, &doc_mode, fixed_mode).await
                }
            }
        } else if reply_as_html && !reply.trim().is_empty() && !reply.starts_with("[LLM Wiki]") {
            // Agent 没按格式输出 HTML：退回文档/文本，避免发出扩展名错误的假 HTML。
            eprintln!("[feishu-html] reply is not HTML, falling back");
            state.status.lock().await.last_error =
                "Agent 未返回 HTML，已降级为文档/文本回复".to_string();
            let title = doc_title(&msg.content);
            fallback_doc_or_text(&msg, &reply, &title, &doc_target, &doc_mode, fixed_mode).await
        } else if reply_as_doc && !reply.trim().is_empty() && !reply.starts_with("[LLM Wiki]") {
            let title = doc_title(&msg.content);
            let target = if fixed_mode {
                doc_target
            } else {
                // 新建模式忽略 fixed_doc，只用目录
                super::feishu::FeishuDocTarget { fixed_doc: String::new(), ..doc_target }
            };
            match super::feishu::publish_feishu_doc(&title, &reply, &target).await {
                Ok(url) => {
                    let mode_note = if doc_mode == "append" {
                        "已追加到固定文档"
                    } else if fixed_mode {
                        "已更新固定文档"
                    } else {
                        ""
                    };
                    eprintln!("[feishu-doc] publish ok ({mode_note}): {title} -> {url}");
                    let text = if fixed_mode {
                        format!("📄 {mode_note}（{title}）\n{url}")
                    } else {
                        format!("📄 {title}\n{url}")
                    };
                    send_feishu_text(&msg.chat_id, &text).await
                }
                Err(err) => {
                    eprintln!("[feishu-doc] publish FAILED: {err}");
                    state.status.lock().await.last_error =
                        format!("doc publish failed: {err}（已降级为文本回复）");
                    let text = if reply.trim().is_empty() {
                        "[LLM Wiki] 本轮没有产生文本回复".to_string()
                    } else {
                        truncate_reply(&reply)
                    };
                    send_feishu_text(&msg.chat_id, &text).await
                }
            }
        } else {
            let text = if reply.trim().is_empty() {
                "[LLM Wiki] 本轮没有产生文本回复".to_string()
            } else {
                truncate_reply(&reply)
            };
            send_feishu_text(&msg.chat_id, &text).await
        };
        if sent.ok {
            state.status.lock().await.handled += 1;
        } else {
            state.status.lock().await.last_error = sent.error;
        }
        // 本轮结束：清 busy，前端进度行消失。
        state.busy.store(false, Ordering::SeqCst);
        state.current_message.lock().await.clear();
        *state.started_at.lock().await = None;
    }
}

/// 从用户消息提炼文档标题：首行去空白，截 24 字符。
fn doc_title(question: &str) -> String {
    let first_line = question.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("回复");
    let title: String = first_line.chars().take(24).collect();
    format!("{title}｜LLM Wiki")
}

/// 粗判 Agent 返回的是不是 HTML：剥掉可能的围栏后，必须以 <!DOCTYPE 或 <html 开头。
///
/// Agent 偶尔会先讲一句话再给源码，这种情况判为否，走文档/文本降级，
/// 避免把 Markdown 存成 .html 发出去。
fn looks_like_html(reply: &str) -> bool {
    let stripped = super::feishu::strip_html_fences(reply);
    let head = stripped.trim_start().to_ascii_lowercase();
    head.starts_with("<!doctype") || head.starts_with("<html")
}

/// HTML 生成/发送失败时的降级：先尝试发布飞书文档，再不行发纯文本。
async fn fallback_doc_or_text(
    msg: &FeishuInbound,
    reply: &str,
    title: &str,
    doc_target: &super::feishu::FeishuDocTarget,
    doc_mode: &str,
    fixed_mode: bool,
) -> super::feishu::FeishuSendResult {
    let target = if fixed_mode {
        doc_target.clone()
    } else {
        super::feishu::FeishuDocTarget { fixed_doc: String::new(), ..doc_target.clone() }
    };
    match super::feishu::publish_feishu_doc(title, reply, &target).await {
        Ok(url) => {
            let mode_note = if doc_mode == "append" {
                "已追加到固定文档"
            } else if fixed_mode {
                "已更新固定文档"
            } else {
                ""
            };
            eprintln!("[feishu-fallback] doc ok: {title} -> {url}");
            let text = if fixed_mode {
                format!("📄 {mode_note}（{title}）\n{url}")
            } else {
                format!("📄 {title}\n{url}")
            };
            send_feishu_text(&msg.chat_id, &text).await
        }
        Err(err) => {
            eprintln!("[feishu-fallback] doc FAILED: {err}");
            let text = if reply.trim().is_empty() {
                "[LLM Wiki] 本轮没有产生文本回复".to_string()
            } else {
                truncate_reply(reply)
            };
            send_feishu_text(&msg.chat_id, &text).await
        }
    }
}

/// 一轮 Agent 调用的结果，附带 skill 注入的实际情况，供设置页展示。
struct AgentRunOutput {
    text: String,
    /// 请求注入的 skill id（未使用 skill 时为空）。
    skill_id: String,
    /// 实际注入成功的 skill 条数：id 不存在时为 0。
    skill_count: usize,
}

/// 进程内复用前端聊天的同一个入口。AI 链路零改动。
///
/// HTML 模式与文档/文本模式的区别只有两处：
/// 1. 显式指定设置里选中的 skill（与聊天界面同一套 `.llm-wiki/skills` 扫描，
///    因此 Agent 可 `skill.read_file` 读取 references/、diagrams/ 等支撑文档）；
/// 2. 追加 HTML 输出要求，让 Agent 直接产出单文件 HTML，
///    省掉原先「先出 Markdown 再二次 LLM 转 HTML」的额外调用。
/// HTML 模式使用独立 sessionId，避免几十 KB 的 HTML 灌进普通对话历史。
async fn run_agent(
    app: &tauri::AppHandle,
    project_id: &str,
    msg: &FeishuInbound,
    reply_format: &str,
    html_skill_id: &str,
) -> Result<AgentRunOutput, String> {
    let is_html = reply_format == "html";

    let message = if is_html {
        format!(
            "{}\n\n{}",
            msg.content,
            super::feishu::FEISHU_HTML_OUTPUT_RULE
        )
    } else if reply_format == "doc" {
        // 文档模式下追加输出格式要求：内容会导入飞书文档，表格/mermaid 才有承载。
        format!(
            "{}\n\n[输出格式要求：用 Markdown 回答；信息优先用表格与 mermaid 代码块呈现，正文文字尽量精简，不要输出与问题无关的寒暄。\n引用要求：每一条来自 wiki 检索结果的事实性结论，必须在该句末尾紧跟 [n]（n 为被引用资料的序号，多来源写 [1][3]）；不使用检索证据的句子标注「（通用知识，无项目来源）」。]",
            msg.content
        )
    } else {
        msg.content.clone()
    };

    // 没选 skill 就不注入，Agent 只按上面的输出要求生成。
    let skills: Vec<String> = if is_html && !html_skill_id.trim().is_empty() {
        vec![html_skill_id.trim().to_string()]
    } else {
        Vec::new()
    };
    let session_id = if is_html {
        format!("feishu_html_{}", msg.chat_id)
    } else {
        format!("feishu_{}", msg.chat_id)
    };
    let requested_skill_id = skills.first().cloned().unwrap_or_default();

    let request: crate::agent::AgentChatRequest = serde_json::from_value(serde_json::json!({
        "message": message,
        "sessionId": session_id,
        "persistSession": true,
        "skills": skills,
        "skillMode": "explicit",
    }))
    .map_err(|err| format!("build request failed: {err}"))?;
    let response = crate::agent_start_turn(app.clone(), project_id.to_string(), request, None).await?;
    // runtime 在注入 skill 后会发 `skills.load`，detail 形如 "1 skill(s) selected"。
    // 直接读这个事件，比事后重新扫盘更准（读到的是本轮真正加载到的条数）。
    let skill_count = response
        .tool_events
        .iter()
        .find(|event| event.tool == "skills.load")
        .and_then(|event| event.detail.as_deref())
        .and_then(|detail| detail.split_whitespace().next())
        .and_then(|count| count.parse::<usize>().ok())
        .unwrap_or(0);
    Ok(AgentRunOutput {
        text: response.message,
        skill_id: requested_skill_id,
        skill_count,
    })
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

    #[test]
    fn detects_network_errors() {
        // 真实踩到的 DNS 失败行
        assert!(is_network_error(
            "2026/09/30 [SDK WARN] get conn url failed, err: Post \"https://open.feishu.cn/callback/ws/endpoint\": dial tcp: lookup open.feishu.cn: no such host"
        ));
        assert!(is_network_error(
            "[SDK ERROR] receive message failed: wsarecv: A connection attempt failed because the connected party did not properly respond after a period of time"
        ));
        // 非网络类输出不应误判
        assert!(!is_network_error("[event] ready event_key=im.message.receive_v1"));
        assert!(!is_network_error("[event] exited"));
    }
}
