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

/// 目录连通性测试结果：ok=true 时 url 为测试文档链接。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeishuDocFolderTestResult {
    pub ok: bool,
    pub url: String,
    pub error: String,
}

/// 设置页「测试目录」按钮：走与真实回复完全相同的发布链路，
/// 在目标目录生成一篇极小的测试文档，验证 token 有效性与凭证可用性。
#[tauri::command]
pub async fn feishu_test_doc_folder(
    folder_token: String,
) -> Result<FeishuDocFolderTestResult, String> {
    let token = folder_token.trim().to_string();
    if token.is_empty() {
        return Ok(FeishuDocFolderTestResult {
            ok: false,
            url: String::new(),
            error: "目录为空：留空表示「我的空间」根目录，无需测试".to_string(),
        });
    }
    let target = FeishuDocTarget { folder_token: token, ..Default::default() };
    match publish_feishu_doc(
        "目录连通性测试（可删除）",
        "看到这篇文档说明目录配置正确。测试完成后可直接删除。",
        &target,
    )
    .await
    {
        Ok(url) => Ok(FeishuDocFolderTestResult { ok: true, url, error: String::new() }),
        Err(err) => Ok(FeishuDocFolderTestResult { ok: false, url: String::new(), error: err }),
    }
}

/// 目标文档校验结果：只读检查，不写入任何内容。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeishuDocTargetTestResult {
    pub ok: bool,
    pub title: String,
    pub url: String,
    pub error: String,
}

/// Device Flow 授权第一步：生成验证链接（用户浏览器确认用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeishuAuthBeginResult {
    pub ok: bool,
    pub verification_url: String,
    pub user_code: String,
    pub device_code: String,
    pub error: String,
}

/// 设置页「生成授权链接」：`auth login --no-wait` 走 Device Flow，
/// 返回 verification_url（含 user_code）。授权域 docs+drive+im 覆盖
/// 文档发布/目录/收发消息所需 scope。auth 子命令在 Trae 外部凭证
/// 环境下被禁用，必须剥离 LARKSUITE_CLI_* 后走配置档身份。
#[tauri::command]
pub async fn feishu_auth_begin() -> Result<FeishuAuthBeginResult, String> {
    let Some(cli) = find_lark_cli() else {
        return Ok(FeishuAuthBeginResult {
            ok: false,
            verification_url: String::new(),
            user_code: String::new(),
            device_code: String::new(),
            error: "lark-cli.exe not found".to_string(),
        });
    };
    let mut cmd = strip_lark_env(Command::new(&cli));
    cmd.arg("auth").arg("login").arg("--no-wait").arg("--json").arg("--domain").arg("docs,drive,im");
    let out = match run_with_timeout(&mut cmd, Duration::from_secs(20)).await {
        Ok(out) => out,
        Err(err) => {
            return Ok(FeishuAuthBeginResult {
                ok: false,
                verification_url: String::new(),
                user_code: String::new(),
                device_code: String::new(),
                error: err,
            })
        }
    };
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let verification_url = extract_json_string_field(&combined, "verification_url").unwrap_or_default();
    let device_code = extract_json_string_field(&combined, "device_code").unwrap_or_default();
    // user_code 在 verification_url 查询串里（...&user_code=XXXX）
    let user_code = verification_url
        .split("user_code=")
        .nth(1)
        .unwrap_or("")
        .trim()
        .to_string();
    if out.status.success() && verification_url.starts_with("http") && !device_code.is_empty() {
        Ok(FeishuAuthBeginResult {
            ok: true,
            verification_url,
            user_code,
            device_code,
            error: String::new(),
        })
    } else {
        let err = extract_json_string_field(&combined, "message")
            .map(|m| format!("lark-cli error: {m}"))
            .unwrap_or_else(|| combined.trim().chars().take(300).collect());
        Ok(FeishuAuthBeginResult {
            ok: false,
            verification_url: String::new(),
            user_code: String::new(),
            device_code: String::new(),
            error: err,
        })
    }
}

/// Device Flow 授权第二步：用户浏览器确认后，用 device_code 完成登录。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeishuAuthCompleteResult {
    pub ok: bool,
    pub error: String,
}

#[tauri::command]
pub async fn feishu_auth_complete(device_code: String) -> Result<FeishuAuthCompleteResult, String> {
    let code = device_code.trim().to_string();
    if code.is_empty() {
        return Ok(FeishuAuthCompleteResult {
            ok: false,
            error: "device_code 为空，请先生成授权链接".to_string(),
        });
    }
    let Some(cli) = find_lark_cli() else {
        return Ok(FeishuAuthCompleteResult {
            ok: false,
            error: "lark-cli.exe not found".to_string(),
        });
    };
    let mut cmd = strip_lark_env(Command::new(&cli));
    cmd.arg("auth").arg("login").arg("--device-code").arg(&code);
    // 用户已点完授权再触发本命令，正常几秒内返回；留 90s 余量
    let out = match run_with_timeout(&mut cmd, Duration::from_secs(90)).await {
        Ok(out) => out,
        Err(err) => {
            return Ok(FeishuAuthCompleteResult { ok: false, error: err })
        }
    };
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    if out.status.success() && !combined.contains("\"ok\": false") {
        Ok(FeishuAuthCompleteResult { ok: true, error: String::new() })
    } else {
        // 常见失败：确认码过期 / 尚未在浏览器完成确认。lark-cli 会打印一段
        // 「[AI agent]…」操作指引，直接透出对桌面用户是噪音，翻译成可操作提示。
        let raw_err = extract_json_string_field(&combined, "message")
            .map(|m| format!("lark-cli error: {m}"))
            .unwrap_or_else(|| combined.trim().chars().take(300).collect::<String>());
        let expired = combined.contains("expired")
            || combined.contains("invalid_grant")
            || combined.contains("device code")
            || combined.contains("[AI agent]");
        let err = if expired {
            format!("{raw_err}；请确认已在浏览器完成授权（确认码 10 分钟内有效）。若已过期，点「生成授权链接」重新走一遍")
        } else {
            raw_err
        };
        Ok(FeishuAuthCompleteResult { ok: false, error: err })
    }
}

/// 设置页「测试文档」按钮：`drive +inspect` 只读校验固定文档 token
/// 是否有效、是否有权限（返回文档标题），不改动文档内容——覆盖模式下
/// 真写测试会毁掉现有内容，所以走只读路径。
#[tauri::command]
pub async fn feishu_test_doc_target(doc_token: String) -> Result<FeishuDocTargetTestResult, String> {
    let token = doc_token.trim().to_string();
    if token.is_empty() {
        return Ok(FeishuDocTargetTestResult {
            ok: false,
            title: String::new(),
            url: String::new(),
            error: "目标文档为空，请先粘贴文档链接".to_string(),
        });
    }
    let Some(cli) = find_lark_cli() else {
        return Ok(FeishuDocTargetTestResult {
            ok: false,
            title: String::new(),
            url: String::new(),
            error: "lark-cli.exe not found".to_string(),
        });
    };

    let token_arg = token.clone();
    let add_args = move |mut cmd: Command| {
        cmd.arg("drive")
            .arg("+inspect")
            .arg("--json")
            .arg("--url")
            .arg(&token_arg)
            .arg("--type")
            .arg("docx");
        cmd
    };
    // 与发布相同的两级身份策略：先继承环境变量，失败再剥离重试
    let run = {
        let mut cmd = Command::new(&cli);
        cmd = add_args(cmd);
        match run_with_timeout(&mut cmd, Duration::from_secs(20)).await {
            Ok(out) => LarkRun::from_output(out),
            Err(err) => {
                return Ok(FeishuDocTargetTestResult {
                    ok: false,
                    title: String::new(),
                    url: String::new(),
                    error: err,
                })
            }
        }
    };
    let (run, combined) = if run.ok {
        let combined = run.combined.clone();
        (run, combined)
    } else {
        let first_err = run.error_message();
        let mut cmd = strip_lark_env(Command::new(&cli));
        cmd = add_args(cmd);
        match run_with_timeout(&mut cmd, Duration::from_secs(20)).await {
            Ok(out) => {
                let retry = LarkRun::from_output(out);
                let combined = retry.combined.clone();
                if retry.ok {
                    (retry, combined)
                } else {
                    let mut err = if retry.error_message() == first_err {
                        retry.error_message()
                    } else {
                        format!("{first_err}；重试后: {}", retry.error_message())
                    };
                    if combined.contains("need_user_authorization")
                        || combined.contains("Authentication token expired")
                    {
                        err = format!("{err}；校验需用户身份，请执行 `lark-cli auth login` 刷新凭证");
                    }
                    return Ok(FeishuDocTargetTestResult {
                        ok: false,
                        title: String::new(),
                        url: String::new(),
                        error: err,
                    });
                }
            }
            Err(err) => {
                return Ok(FeishuDocTargetTestResult {
                    ok: false,
                    title: String::new(),
                    url: String::new(),
                    error: err,
                })
            }
        }
    };

    let title = extract_json_string_field(&combined, "title").unwrap_or_default();
    let url = extract_json_string_field(&combined, "url")
        .filter(|u| u.starts_with("http"))
        .unwrap_or_default();
    if run.ok && !title.is_empty() {
        Ok(FeishuDocTargetTestResult { ok: true, title, url, error: String::new() })
    } else {
        Ok(FeishuDocTargetTestResult {
            ok: false,
            title: String::new(),
            url: String::new(),
            error: run.error_message(),
        })
    }
}

/// 把 ```mermaid 代码块替换为「渲染图 + 源码」组合（实测 2026-09-29）：
/// 渲染图走 mermaid.ink base64url 直编链接，飞书导入时自动下载内嵌为
/// 图片块；源码块原样保留在图下方，方便复制修改。
/// 解析不了的块原样保留，交给调用方降级逻辑兜底。
fn mermaid_to_images(markdown: &str) -> String {
    use base64::Engine;
    let engine = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    const TAG: &str = "```mermaid";
    let mut out = String::with_capacity(markdown.len());
    let mut rest = markdown;
    while let Some(start) = rest.find(TAG) {
        let after_tag = &rest[start + TAG.len()..];
        // 语言标注同行剩余字符（如 ```mermaid title=x）到行尾
        let Some(nl) = after_tag.find('\n') else {
            out.push_str(rest);
            return out;
        };
        let body_start = start + TAG.len() + nl + 1;
        let Some(close) = rest[body_start..].find("\n```") else {
            out.push_str(rest);
            return out;
        };
        let block_end = body_start + close + "\n```".len();
        let code = rest[body_start..body_start + close].trim_end_matches('\r');
        let url = format!("https://mermaid.ink/img/{}", engine.encode(code.as_bytes()));
        out.push_str(&rest[..start]);
        // 渲染图在前，源码块紧随其后（注意从 start 开始，只保留块本身，
        // 不能把前文重复抄一遍）
        out.push_str(&format!("![图表]({url})\n\n"));
        out.push_str(&rest[start..block_end]);
        out.push('\n');
        rest = &rest[block_end..];
    }
    out.push_str(rest);
    out
}

/// 文档发布目标：由前端配置（feishuConfig.bridgeDoc*）归一化后传给桥接。
#[derive(Debug, Clone, Default)]
pub(crate) struct FeishuDocTarget {
    /// 新建文档的目录（文件夹 token，空 = 我的空间根目录）。
    pub folder_token: String,
    /// 固定文档 token（docx token，空 = 每次新建）。
    pub fixed_doc: String,
    /// 固定文档写法：overwrite=整体覆盖；append=追加到文末。
    pub fixed_command: String,
}

/// 聊天界面飞书通知的文档发布结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeishuDocPublishResult {
    pub ok: bool,
    pub url: String,
    pub error: String,
}

/// 聊天界面铃铛通知「回复为飞书文档」：与机器人回复走同一条发布链路、
/// 同一套文档设置（目录/模式/固定文档）。失败返回 ok=false 由前端降级
/// 为完整原文文本消息。
#[tauri::command]
pub async fn feishu_publish_chat_reply(
    app: tauri::AppHandle,
    title: String,
    markdown: String,
) -> Result<FeishuDocPublishResult, String> {
    let cfg = crate::api_server::load_app_state(&app)
        .and_then(|v| v.get("feishuConfig").cloned())
        .unwrap_or(serde_json::Value::Null);
    let cfg_str = |key: &str| {
        cfg.get(key)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    let mode = cfg
        .get("bridgeDocMode")
        .and_then(|v| v.as_str())
        .unwrap_or("new")
        .to_string();
    let target = FeishuDocTarget {
        folder_token: cfg_str("bridgeDocFolder"),
        fixed_doc: cfg_str("bridgeDocTarget"),
        fixed_command: if mode == "append" { "append".into() } else { "overwrite".into() },
    };
    match publish_feishu_doc(&title, &markdown, &target).await {
        Ok(url) => Ok(FeishuDocPublishResult { ok: true, url, error: String::new() }),
        Err(err) => Ok(FeishuDocPublishResult { ok: false, url: String::new(), error: err }),
    }
}

/// 固定文档（overwrite/append）模式防御性规整（实测 2026-09-30）：
/// 1) 个别回复整段挤成一行（无换行），`docs +update` 会把首行 `# …`
///    整行提为文档标题导致"标题变成全文"；在 `## ` 前恢复段落换行。
/// 2) 首个 `# ` 一级标题降为 `## `——markdown 的一级标题会被提为文档
///    标题，降级后文档标题保持原状（固定文档）或仍由 --name 控制。
fn normalize_fixed_markdown(markdown: &str) -> String {
    let mut text = markdown.trim().to_string();
    // 单行检测：几乎没有真实换行但内含 "## " → 在各二级标题前补换行
    if text.matches('\n').count() < 2 && text.contains(" ## ") {
        text = text.replace(" ## ", "\n\n## ");
    }
    // 首行一级标题降级
    if let Some(rest) = text.strip_prefix("# ") {
        text = format!("## {rest}");
    }
    text
}

/// 权限 patch 命令参数构造（token 为目标文档 docx token）。
fn perm_patch_args(cmd: &mut Command, token: &str) {
    cmd.arg("drive")
        .arg("permission.public")
        .arg("patch")
        .arg("--json")
        .arg("--yes")
        .arg("--token")
        .arg(token)
        .arg("--type")
        .arg("docx")
        .arg("--data")
        .arg(r#"{"link_share_entity":"tenant_editable"}"#);
}

/// 重设文档标题（user 身份，两级尝试，尽力而为）。
/// `docs +update overwrite` 只换正文不重置标题——历史上被挤成单行的回复
/// 曾把标题写坏，这里在覆盖模式下每次把标题拉回「问题摘要｜LLM Wiki」。
async fn set_doc_title(cli: &PathBuf, doc_url: &str, title: &str) {
    let token = doc_url.rsplit('/').next().unwrap_or("").split('?').next().unwrap_or("");
    if token.is_empty() || title.trim().is_empty() {
        return;
    }
    let title_arg = title.trim().to_string();
    let mut run = {
        let mut cmd = Command::new(cli);
        cmd.arg("drive")
            .arg("+update-title")
            .arg("--json")
            .arg("--url")
            .arg(doc_url)
            .arg("--title")
            .arg(&title_arg);
        match run_with_timeout(&mut cmd, Duration::from_secs(20)).await {
            Ok(out) => LarkRun::from_output(out),
            Err(err) => {
                eprintln!("[feishu-doc] set title failed: {err}");
                return;
            }
        }
    };
    if !run.ok {
        let mut cmd = strip_lark_env(Command::new(cli));
        cmd.arg("drive")
            .arg("+update-title")
            .arg("--json")
            .arg("--url")
            .arg(doc_url)
            .arg("--title")
            .arg(&title_arg);
        run = match run_with_timeout(&mut cmd, Duration::from_secs(20)).await {
            Ok(out) => LarkRun::from_output(out),
            Err(err) => {
                eprintln!("[feishu-doc] set title failed: {err}");
                return;
            }
        };
    }
    if !run.ok {
        eprintln!("[feishu-doc] set title failed: {}", run.error_message());
    }
}

/// 把文档链接分享权限设为「组织内获得链接的人可查看和编辑」。
/// 权限接口需要用户身份：两级尝试（继承环境变量 → 剥离重试）。
/// 尽力而为：失败只记日志不阻断回复（例如租户禁用了该权限设置）。
async fn set_doc_link_editable(cli: &PathBuf, doc_url: &str) {
    let token = doc_url.rsplit('/').next().unwrap_or("").split('?').next().unwrap_or("");
    if token.is_empty() {
        return;
    }
    let first = {
        let mut cmd = Command::new(cli);
        perm_patch_args(&mut cmd, token);
        run_with_timeout(&mut cmd, Duration::from_secs(20)).await
    };
    let run = match first {
        Ok(out) => {
            let first_run = LarkRun::from_output(out);
            if first_run.ok {
                first_run
            } else {
                let mut cmd = strip_lark_env(Command::new(cli));
                perm_patch_args(&mut cmd, token);
                match run_with_timeout(&mut cmd, Duration::from_secs(20)).await {
                    Ok(out) => LarkRun::from_output(out),
                    Err(err) => {
                        eprintln!("[feishu-doc] set link-share failed: {err}");
                        return;
                    }
                }
            }
        }
        Err(err) => {
            eprintln!("[feishu-doc] set link-share failed: {err}");
            return;
        }
    };
    if !run.ok {
        eprintln!("[feishu-doc] set link-share failed: {}", run.error_message());
    }
}

/// 把 Markdown 回复发布为飞书文档，返回文档 URL。
///
/// 三种模式（实测 2026-09-29）：
/// - 新建：`drive +import --type docx --folder-token`，远程图片（mermaid 转图）
///   会被飞书下载内嵌。
/// - 覆盖固定文档：`docs +update --command overwrite --doc-format markdown`，
///   整体替换内容且 URL 稳定，mermaid 图片同样内嵌。
/// - 追加固定文档：`docs +update --command append`，本次回复接在文末，
///   自动加「--- + 问题标题」分隔，形成问答日志。
///
/// 身份策略与 IM 发送相反：以上均为用户身份命令（lark-cli 严格模式禁止 bot
/// 导入/改写文档，且该 bot 应用未申请 docs/drive scope），因此不传 `--as bot`。
/// 两级尝试：先带继承环境变量（Trae 会话注入的新鲜用户 token），失败再剥离
/// 重试（回落 ~/.lark-cli 配置档）。都失败返回 Err，调用方降级为纯文本回复。
pub(crate) async fn publish_feishu_doc(
    title: &str,
    markdown: &str,
    target: &FeishuDocTarget,
) -> Result<String, String> {
    let Some(cli) = find_lark_cli() else {
        return Err("lark-cli.exe not found".to_string());
    };

    let fixed_arg = target.fixed_doc.trim().to_string();
    let is_append = !fixed_arg.is_empty() && target.fixed_command == "append";
    // 固定文档（overwrite/append）模式：先做防御性规整——恢复被挤成单行的
    // 回复段落结构、首个 H1 降级（H1 会被 docs +update 提为文档标题）。
    // 追加模式再加分隔线 + 问题标题，让文档读起来像问答日志。
    let final_markdown = if fixed_arg.is_empty() {
        markdown.to_string()
    } else {
        let normalized = normalize_fixed_markdown(markdown);
        if is_append {
            format!("---\n\n## {title}\n\n{normalized}")
        } else {
            normalized
        }
    };

    // 写临时 md 文件（发布完成后尽力删除）；mermaid 块预转图片链接
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("llm-wiki-feishu-{ts}.md"));
    std::fs::write(&path, mermaid_to_images(&final_markdown))
        .map_err(|e| format!("write temp file failed: {e}"))?;

    let title_arg = title.to_string();
    let file_arg = path.to_string_lossy().to_string();
    let folder_arg = target.folder_token.trim().to_string();
    let fixed_command = if is_append { "append" } else { "overwrite" };
    let is_fixed = !fixed_arg.is_empty();
    let add_args = move |mut cmd: Command| {
        if fixed_arg.is_empty() {
            // 新建：导入为 docx，可选指定目录
            cmd.arg("drive")
                .arg("+import")
                .arg("--json")
                .arg("--file")
                .arg(&file_arg)
                .arg("--type")
                .arg("docx")
                .arg("--name")
                .arg(&title_arg);
            if !folder_arg.is_empty() {
                cmd.arg("--folder-token").arg(&folder_arg);
            }
        } else {
            // 固定文档：append=文末追加；overwrite=整体覆盖
            cmd.arg("docs")
                .arg("+update")
                .arg("--json")
                .arg("--doc")
                .arg(&fixed_arg)
                .arg("--command")
                .arg(fixed_command)
                .arg("--doc-format")
                .arg("markdown")
                .arg("--content")
                .arg(format!("@{file_arg}"));
        }
        cmd
    };

    // 两级身份策略：
    // 1) 保留继承环境变量：应用若从带 LARKSUITE_CLI_USER_ACCESS_TOKEN 的
    //    会话启动（如 Trae 终端），直接用这份新鲜用户 token，最稳。
    // 2) 剥离 LARKSUITE_CLI_* 重试：普通启动时回落 ~/.lark-cli 配置档的
    //    用户 token；若配置档 token 也过期则 lark-cli 落到 bot 身份并报
    //    scope 错误，此时返回 Err 由调用方降级为文本回复。
    let mut run = {
        let mut cmd = Command::new(&cli);
        cmd = add_args(cmd);
        match run_with_timeout(&mut cmd, Duration::from_secs(60)).await {
            Ok(out) => LarkRun::from_output(out),
            Err(err) => {
                let _ = std::fs::remove_file(&path);
                return Err(err);
            }
        }
    };
    let mut url = extract_json_string_field(&run.combined, "url").unwrap_or_default();
    if !(run.ok && url.starts_with("http")) {
        let first_err = run.error_message();
        let retry = {
            let mut cmd = strip_lark_env(Command::new(&cli));
            cmd = add_args(cmd);
            match run_with_timeout(&mut cmd, Duration::from_secs(60)).await {
                Ok(out) => LarkRun::from_output(out),
                Err(err) => {
                    let _ = std::fs::remove_file(&path);
                    return Err(err);
                }
            }
        };
        run = retry;
        url = extract_json_string_field(&run.combined, "url").unwrap_or_default();
        if !(run.ok && url.starts_with("http")) {
            let _ = std::fs::remove_file(&path);
            // 补充可操作提示：最常见的失败是用户凭证失效
            let mut err = if run.error_message() == first_err || first_err.is_empty() {
                run.error_message()
            } else {
                format!("{first_err}；重试后: {}", run.error_message())
            };
            if run.combined.contains("need_user_authorization")
                || run.combined.contains("app_scope_not_applied")
                || run.combined.contains("Authentication token expired")
            {
                err = format!("{err}；导入文档需用户身份，请在终端执行 `lark-cli auth login` 刷新用户凭证后重试");
            }
            return Err(err);
        }
    }
    let _ = std::fs::remove_file(&path);
    // 覆盖模式：把标题拉回「问题摘要｜LLM Wiki」（治旧伤+防新劫持）；
    // 追加模式不动标题（长日志文档标题保持用户设定）。
    if is_fixed && !is_append {
        set_doc_title(&cli, &url, title).await;
    }
    // 默认放开链接分享：组织内获得链接的人可查看和编辑（尽力而为）
    set_doc_link_editable(&cli, &url).await;
    Ok(url)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mermaid_block_becomes_image_plus_source() {
        let md = "前文\n\n```mermaid\ngraph LR\n    A --> B\n```\n\n后文";
        let out = mermaid_to_images(md);
        assert!(out.contains("![图表](https://mermaid.ink/img/"), "got: {out}");
        // 渲染图在前，源码块在后
        let img_pos = out.find("![图表]").expect("has image");
        let code_pos = out.find("```mermaid\ngraph LR").expect("has source");
        assert!(img_pos < code_pos, "image should precede source: {out}");
        assert!(out.starts_with("前文"));
        assert!(out.ends_with("后文"));
        assert_eq!(out.matches("```").count(), 2, "one fenced block kept: {out}");
        // 关键回归断言：前文/后文不得被重复
        assert_eq!(out.matches("前文").count(), 1, "prefix duplicated: {out}");
        assert_eq!(out.matches("后文").count(), 1, "suffix duplicated: {out}");
    }

    #[test]
    fn other_code_blocks_untouched() {
        let md = "```rust\nfn main() {}\n```";
        assert_eq!(mermaid_to_images(md), md);
    }

    #[test]
    fn multiple_mermaid_blocks_all_converted() {
        let md = "```mermaid\nA --> B\n```\nmid\n```mermaid\nC --> D\n```";
        let out = mermaid_to_images(md);
        assert_eq!(out.matches("https://mermaid.ink/img/").count(), 2);
        assert_eq!(out.matches("```mermaid").count(), 2);
        assert_eq!(out.matches("mid").count(), 1, "middle text duplicated: {out}");
    }

    #[test]
    fn fixed_markdown_demotes_leading_h1() {
        let md = "# 大标题\n\n## 小节\n\n正文";
        let out = normalize_fixed_markdown(md);
        assert!(out.starts_with("## 大标题"), "got: {out}");
        assert!(out.contains("## 小节"));
    }

    #[test]
    fn fixed_markdown_reflows_single_line_reply() {
        // 模拟整段挤成一行的回复：## 前恢复换行，首个 # 降级
        let md = "# 概览 ## 一句话 内容甲 ## 板块 内容乙";
        let out = normalize_fixed_markdown(md);
        assert!(out.starts_with("## 概览"), "got: {out}");
        assert!(out.contains("\n\n## 一句话"), "headings not reflowed: {out}");
        assert!(out.contains("\n\n## 板块"), "headings not reflowed: {out}");
    }

    #[test]
    fn fixed_markdown_keeps_multiline_intact() {
        let md = "## 标题\n\n| a | b |\n|---|---|\n| 1 | 2 |";
        let out = normalize_fixed_markdown(md);
        assert_eq!(out, md);
    }
}
