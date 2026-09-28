use serde::Serialize;
use std::path::PathBuf;
use std::time::Duration;
use tokio::process::Command;

/// 飞书通知：复用本机 lark-cli（Trae 插件目录或 PATH）发送消息。
///
/// 身份策略（经实测验证，2026-09-27）：
/// - **发送一律用 `--as bot`**：应用由用户自己启动时拿不到 Trae 注入的
///   LARKSUITE_CLI_USER_ACCESS_TOKEN，只剩 ~/.lark-cli/config.json 配置档，
///   而该档的 user token 往往陈旧（缓存用户无 token）会报 need_user_authorization；
///   但 appSecret 存在 Windows keychain 里，bot 身份始终可用。
/// - 配置里剔除 LARKSUITE_CLI_*：避免只注入 APP_ID 而无 secret 时被
///   "blocked by env" 拒绝；必须保留 USERPROFILE（lark-cli 靠它定位配置）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeishuDetectResult {
    pub available: bool,
    pub cli_path: String,
    pub version: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeishuSendResult {
    pub ok: bool,
    pub message_id: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeishuMyIdResult {
    pub ok: bool,
    pub open_id: String,
    pub name: String,
    pub p2p_chat_id: String,
    pub error: String,
}

/// 在 PATH 和 Trae 插件目录里找 lark-cli.exe，取版本最高的。
pub(crate) fn find_lark_cli() -> Option<PathBuf> {
    let mut candidates: Vec<(Vec<u64>, PathBuf)> = Vec::new();

    // 1) PATH 上的 lark-cli（版本未知，排最低优先级）
    if let Some(path) = which::which("lark-cli").ok() {
        candidates.push((vec![0], path));
    }

    // 2) Trae 插件目录: %USERPROFILE%\.trae-cn\plugins\*\lark\*\bin\lark-cli.exe
    if let Ok(home) = std::env::var("USERPROFILE") {
        let plugins_root = PathBuf::from(&home).join(".trae-cn").join("plugins");
        if let Ok(registries) = std::fs::read_dir(&plugins_root) {
            for registry in registries.flatten() {
                let lark_root = registry.path().join("lark");
                let Ok(versions) = std::fs::read_dir(&lark_root) else {
                    continue;
                };
                for version_dir in versions.flatten() {
                    let ver = version_dir.file_name().to_string_lossy().to_string();
                    let exe = version_dir.path().join("bin").join("lark-cli.exe");
                    if exe.is_file() {
                        candidates.push((parse_version(&ver), exe));
                    }
                }
            }
        }
    }

    candidates
        .into_iter()
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, path)| path)
}

/// "1.0.10" -> [1, 0, 10]
fn parse_version(s: &str) -> Vec<u64> {
    s.trim_start_matches('v')
        .split('.')
        .map(|seg| seg.parse::<u64>().unwrap_or(0))
        .collect()
}

/// 剔除 LARKSUITE_CLI_* 注入变量的 Command（其余继承父进程，USERPROFILE 随之保留）。
pub(crate) fn strip_lark_env(mut cmd: Command) -> Command {
    for (key, _) in std::env::vars() {
        if key.starts_with("LARKSUITE_CLI_") {
            cmd.env_remove(&key);
        }
    }
    cmd
}

async fn run_with_timeout(cmd: &mut Command, timeout: Duration) -> Result<std::process::Output, String> {
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null());
    match tokio::time::timeout(timeout, cmd.output()).await {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(e)) => Err(format!("failed to spawn lark-cli: {e}")),
        Err(_) => Err("lark-cli timed out".to_string()),
    }
}

/// lark-cli 输出（合并 stdout/stderr 便于容错解析）。
struct LarkRun {
    ok: bool,
    status: std::process::ExitStatus,
    stdout: String,
    combined: String,
}

impl LarkRun {
    fn from_output(out: std::process::Output) -> Self {
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        let combined = format!("{stdout}{stderr}");
        let ok = out.status.success() && combined.contains("\"ok\": true");
        LarkRun { ok, status: out.status, stdout, combined }
    }

    /// 失败时的错误描述：优先取 JSON 里的 message，否则截断原始输出。
    fn error_message(&self) -> String {
        extract_json_string_field(&self.combined, "message")
            .map(|m| format!("lark-cli error: {m}"))
            .unwrap_or_else(|| {
                format!(
                    "lark-cli exited with {}: {}",
                    self.status,
                    self.combined.trim().chars().take(300).collect::<String>()
                )
            })
    }
}

/// 以 bot 身份跑 lark-cli（剔除 Trae 注入变量，回落 ~/.lark-cli 配置档）。
async fn run_lark_as_bot<F>(cli: &PathBuf, add_args: F) -> Result<LarkRun, String>
where
    F: Fn(&mut Command),
{
    let mut cmd = strip_lark_env(Command::new(cli));
    add_args(&mut cmd);
    let out = run_with_timeout(&mut cmd, Duration::from_secs(20)).await?;
    Ok(LarkRun::from_output(out))
}

/// 读取 ~/.lark-cli/config.json 里已登录的用户身份（open_id / 用户名）。
/// 供设置页「获取我的 ID」用：该命令只支持 user 身份，而配置档的 user token
/// 可能已失效（实测无法用它发消息），但缓存里的 open_id 依然有效，
/// 配合 bot 发送正好可用。
fn read_config_identity() -> Option<(String, String)> {
    let home = std::env::var("USERPROFILE").ok()?;
    let config_path = PathBuf::from(home).join(".lark-cli").join("config.json");
    let text = std::fs::read_to_string(config_path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    for app in json.get("apps")?.as_array()? {
        let Some(users) = app.get("users").and_then(|u| u.as_array()) else {
            continue;
        };
        for user in users {
            let open_id = user.get("userOpenId").and_then(|v| v.as_str()).unwrap_or("");
            if open_id.starts_with("ou_") {
                let name = user.get("userName").and_then(|v| v.as_str()).unwrap_or("");
                return Some((open_id.to_string(), name.to_string()));
            }
        }
    }
    None
}

#[tauri::command]
pub async fn feishu_detect() -> Result<FeishuDetectResult, String> {
    let Some(cli) = find_lark_cli() else {
        return Ok(FeishuDetectResult {
            available: false,
            cli_path: String::new(),
            version: String::new(),
            error: "lark-cli.exe not found in PATH or ~/.trae-cn/plugins".to_string(),
        });
    };

    // 用 --version 探活（不发网络请求）
    let mut cmd = strip_lark_env(Command::new(&cli));
    let output = cmd.arg("--version").output().await;
    let (version, error) = match output {
        Ok(out) if out.status.success() => {
            let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let ver = text
                .lines()
                .next()
                .unwrap_or("")
                .split_whitespace()
                .last()
                .unwrap_or("")
                .to_string();
            (ver, String::new())
        }
        Ok(out) => (
            String::new(),
            format!(
                "lark-cli --version failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ),
        ),
        Err(e) => (String::new(), format!("failed to run lark-cli: {e}")),
    };

    Ok(FeishuDetectResult {
        available: error.is_empty(),
        cli_path: cli.to_string_lossy().to_string(),
        version,
        error,
    })
}

/// 以 bot 身份发送文本消息，返回统一结果结构。
/// 桥接模块与 `feishu_send_message` 命令共用，保证发送行为完全一致。
pub(crate) async fn send_feishu_text(recipient_id: &str, text: &str) -> FeishuSendResult {
    let recipient = recipient_id.trim().to_string();
    if recipient.is_empty() {
        return FeishuSendResult {
            ok: false,
            message_id: String::new(),
            error: "recipient is empty".to_string(),
        };
    }
    let Some(cli) = find_lark_cli() else {
        return FeishuSendResult {
            ok: false,
            message_id: String::new(),
            error: "lark-cli.exe not found".to_string(),
        };
    };

    if !recipient.starts_with("ou_") && !recipient.starts_with("oc_") {
        return FeishuSendResult {
            ok: false,
            message_id: String::new(),
            error: "recipient must be an open_id (ou_...) or chat_id (oc_...)".to_string(),
        };
    }

    let recipient_arg = recipient.clone();
    let run = match run_lark_as_bot(&cli, |cmd| {
        cmd.arg("im").arg("+messages-send").arg("--json").arg("--as").arg("bot");
        if recipient_arg.starts_with("ou_") {
            cmd.arg("--user-id").arg(&recipient_arg);
        } else {
            cmd.arg("--chat-id").arg(&recipient_arg);
        }
        cmd.arg("--text").arg(text);
    })
    .await
    {
        Ok(run) => run,
        Err(err) => {
            return FeishuSendResult {
                ok: false,
                message_id: String::new(),
                error: err,
            }
        }
    };

    let message_id = extract_json_string_field(&run.stdout, "message_id")
        .or_else(|| extract_json_string_field(&run.combined, "message_id"))
        .unwrap_or_default();
    if run.ok {
        FeishuSendResult { ok: true, message_id, error: String::new() }
    } else {
        FeishuSendResult {
            ok: false,
            message_id: String::new(),
            error: run.error_message(),
        }
    }
}

#[tauri::command]
pub async fn feishu_send_message(recipient_id: String, text: String) -> Result<FeishuSendResult, String> {
    Ok(send_feishu_text(&recipient_id, &text).await)
}

/// 查询「我的」飞书身份，用于设置页一键填入收件人。
/// 直接读 ~/.lark-cli/config.json 的缓存身份：该命令对应的 lark-cli
/// `contact +search-user` 只支持 user 身份，而配置档的 user token 常已失效
/// （实测报 need_user_authorization）；缓存里的 open_id 却是有效的，
/// 发给它（走 bot 身份）能正常送达。
#[tauri::command]
pub async fn feishu_get_my_id() -> Result<FeishuMyIdResult, String> {
    match read_config_identity() {
        Some((open_id, name)) => Ok(FeishuMyIdResult {
            ok: true,
            open_id,
            name,
            p2p_chat_id: String::new(),
            error: String::new(),
        }),
        None => Ok(FeishuMyIdResult {
            ok: false,
            open_id: String::new(),
            name: String::new(),
            p2p_chat_id: String::new(),
            error: "no logged-in user in ~/.lark-cli/config.json".to_string(),
        }),
    }
}

/// 从 JSON 文本里提取 "field": "value" 字符串值。
/// lark-cli 输出可能混杂警告行，全量 serde 解析容易失败，用轻量扫描。
fn extract_json_string_field(json: &str, field: &str) -> Option<String> {
    let needle = format!("\"{field}\":");
    let pos = json.find(&needle)?;
    let rest = json[pos + needle.len()..].trim_start();
    let rest = rest.strip_prefix('"')?;
    let mut value = String::new();
    let mut escaped = false;
    for ch in rest.chars() {
        if escaped {
            value.push(ch);
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
        } else if ch == '"' {
            return Some(value);
        } else {
            value.push(ch);
        }
    }
    None
}
