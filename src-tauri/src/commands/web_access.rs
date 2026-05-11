use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartWebAccessProxyResult {
    pub ok: bool,
    pub message: String,
    pub script_path: String,
    pub pid: Option<u32>,
}

#[tauri::command]
pub async fn start_web_access_proxy(
    script_path: Option<String>,
) -> Result<StartWebAccessProxyResult, String> {
    tauri::async_runtime::spawn_blocking(move || start_web_access_proxy_blocking(script_path))
        .await
        .map_err(|e| format!("start_web_access_proxy blocking task join error: {e}"))?
}

fn start_web_access_proxy_blocking(
    script_path: Option<String>,
) -> Result<StartWebAccessProxyResult, String> {
    let script = resolve_script_path(script_path)?;
    validate_script_path(&script)?;
    let node = which::which("node").map_err(|_| {
        "未找到 node 命令。请先安装 Node.js，并确认 node 已加入 PATH。".to_string()
    })?;

    let mut command = Command::new(node);
    command
        .arg(&script)
        .current_dir(script.parent().unwrap_or_else(|| Path::new(".")))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let child = command
        .spawn()
        .map_err(|e| format!("启动 WebAccess 检查脚本失败：{e}"))?;
    let pid = child.id();

    Ok(StartWebAccessProxyResult {
        ok: true,
        message: "已发送 WebAccess 代理启动请求。若 Chrome 弹出远程调试授权，请点击允许，然后重新检查连接。"
            .to_string(),
        script_path: script.display().to_string(),
        pid: Some(pid),
    })
}

fn resolve_script_path(script_path: Option<String>) -> Result<PathBuf, String> {
    let trimmed = script_path.unwrap_or_default().trim().to_string();
    if !trimmed.is_empty() {
        return Ok(PathBuf::from(expand_home_vars(&trimmed)));
    }

    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "无法定位用户目录，请手动填写 WebAccess check-deps.mjs 路径。".to_string())?;

    Ok(PathBuf::from(home)
        .join(".agents")
        .join("skills")
        .join("web-access")
        .join("scripts")
        .join("check-deps.mjs"))
}

fn validate_script_path(path: &Path) -> Result<(), String> {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if file_name != "check-deps.mjs" {
        return Err("安全限制：只能启动名为 check-deps.mjs 的 WebAccess 检查脚本。".to_string());
    }

    if !path.exists() {
        return Err(format!("WebAccess 脚本不存在：{}", path.display()));
    }
    if !path.is_file() {
        return Err(format!("WebAccess 脚本路径不是文件：{}", path.display()));
    }

    Ok(())
}

fn expand_home_vars(value: &str) -> String {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();

    let expanded = value.replace("%USERPROFILE%", &home).replace("$HOME", &home);
    if expanded == "~" {
        home
    } else if let Some(rest) = expanded.strip_prefix("~/").or_else(|| expanded.strip_prefix("~\\")) {
        PathBuf::from(home).join(rest).display().to_string()
    } else {
        expanded
    }
}

#[cfg(test)]
mod tests {
    use super::expand_home_vars;

    #[test]
    fn expands_common_home_placeholders() {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_default();
        let expanded = expand_home_vars("%USERPROFILE%/.agents/skills/web-access/scripts/check-deps.mjs");
        assert!(expanded.contains(&home));
    }
}
