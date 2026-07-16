use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const LOGIN_SHELL_PATH_TIMEOUT: Duration = Duration::from_secs(3);
const PATH_MARKER: char = '\x1e';

static RESOLVED_COMMANDS: OnceLock<Mutex<HashMap<String, PathBuf>>> = OnceLock::new();

#[cfg(not(windows))]
static RESOLVED_SHELL_PATH: OnceLock<Option<String>> = OnceLock::new();

/// PATH to hand a spawned CLI so its interpreter resolves.
///
/// On macOS a GUI launch (Finder/Dock) inherits launchd's minimal PATH, which
/// omits version-manager dirs (nvm, etc.). Locating the binary already falls
/// back to the login shell PATH; node-shim CLIs like `codex`
/// (`#!/usr/bin/env node`) additionally need that PATH at *run* time so their
/// shebang finds `node`. We prepend the login shell PATH to the inherited one
/// (cached, so the shell is spawned at most once). Returns `None` when there is
/// nothing to add, in which case the child should inherit PATH unchanged.
#[cfg(not(windows))]
pub(crate) async fn child_path_env() -> Option<String> {
    let shell_path = tokio::task::spawn_blocking(|| {
        RESOLVED_SHELL_PATH
            .get_or_init(|| login_shell_path(LOGIN_SHELL_PATH_TIMEOUT))
            .clone()
    })
    .await
    .ok()
    .flatten()?;
    Some(merge_child_path_env(
        &shell_path,
        std::env::var("PATH").ok().as_deref(),
    ))
}

#[cfg(windows)]
pub(crate) async fn child_path_env() -> Option<String> {
    None
}

#[cfg(not(windows))]
fn merge_child_path_env(shell_path: &str, inherited_path: Option<&str>) -> String {
    match inherited_path {
        Some(current) if !current.is_empty() => format!("{shell_path}:{current}"),
        _ => shell_path.to_string(),
    }
}

pub(crate) async fn find_cli_command(
    command: &str,
    windows_candidates: &[&str],
) -> Result<PathBuf, String> {
    if let Some(path) = cached_command(command) {
        return Ok(path);
    }

    let command = command.to_string();
    let cache_key = command.clone();
    let windows_candidates = windows_candidates
        .iter()
        .map(|candidate| (*candidate).to_string())
        .collect::<Vec<_>>();
    let path = tokio::task::spawn_blocking(move || {
        find_cli_command_uncached(&command, &windows_candidates)
    })
    .await
    .map_err(|e| format!("Failed to resolve CLI command: {e}"))??;

    cache_command(cache_key, path.clone());
    Ok(path)
}

fn command_cache() -> &'static Mutex<HashMap<String, PathBuf>> {
    RESOLVED_COMMANDS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cached_command(command: &str) -> Option<PathBuf> {
    let mut cache = command_cache().lock().ok()?;
    let path = cache.get(command)?.clone();
    if path.exists() {
        Some(path)
    } else {
        cache.remove(command);
        None
    }
}

fn cache_command(command: String, path: PathBuf) {
    if let Ok(mut cache) = command_cache().lock() {
        cache.insert(command, path);
    }
}

#[cfg_attr(not(windows), allow(unused_variables))]
fn find_cli_command_uncached(
    command: &str,
    windows_candidates: &[String],
) -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        for candidate in windows_candidates
            .iter()
            .map(String::as_str)
            .chain(std::iter::once(command))
        {
            if let Ok(path) = which::which(candidate) {
                return Ok(path);
            }
        }
        return Err(format!("`{command}` not found on PATH"));
    }

    #[cfg(not(windows))]
    {
        if let Ok(path) = which::which(command) {
            return Ok(path);
        }

        if let Some(full_path) = login_shell_path(LOGIN_SHELL_PATH_TIMEOUT) {
            if let Ok(path) = which::which_in(command, Some(&full_path), ".") {
                return Ok(path);
            }
        }

        Err(format!("`{command}` not found on PATH"))
    }
}

#[cfg(not(windows))]
fn login_shell_path(timeout: Duration) -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let shell_name = PathBuf::from(&shell)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let shell_args = if matches!(shell_name.as_str(), "sh" | "dash" | "ash") {
        vec!["-ic", r#"printf '\036PATH=%s\036\n' "$PATH""#]
    } else {
        vec!["-ilc", r#"printf '\036PATH=%s\036\n' "$PATH""#]
    };
    let mut child = Command::new(&shell)
        // `-i` is intentional: many version managers only update PATH
        // from interactive shell rc files. The timeout below bounds
        // unusual shell configs that hang when run with null stdio.
        // Minimal /bin/sh variants often do not support `-l`, so they
        // use `-ic` while zsh/bash/fish keep the login shell path.
        .args(shell_args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                let output = child.wait_with_output().ok()?;
                let stdout = String::from_utf8_lossy(&output.stdout);
                return parse_shell_path_output(&stdout);
            }
            Ok(None) if start.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(_) => return None,
        }
    }
}

#[cfg(not(windows))]
fn parse_shell_path_output(stdout: &str) -> Option<String> {
    for line in stdout.lines() {
        if let Some(rest) = line.strip_prefix(PATH_MARKER) {
            if let Some(val) = rest.strip_suffix(PATH_MARKER) {
                if let Some(path) = val.strip_prefix("PATH=") {
                    if !path.is_empty() {
                        return Some(path.to_string());
                    }
                }
            }
        }
    }
    None
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::{merge_child_path_env, parse_shell_path_output};

    #[test]
    fn parse_shell_path_output_ignores_banners() {
        let output = "Welcome\n\x1ePATH=/opt/homebrew/bin:/usr/bin\x1e\nGoodbye\n";
        assert_eq!(
            parse_shell_path_output(output).as_deref(),
            Some("/opt/homebrew/bin:/usr/bin")
        );
    }

    #[test]
    fn parse_shell_path_output_rejects_missing_or_empty_markers() {
        assert_eq!(parse_shell_path_output("PATH=/usr/bin"), None);
        assert_eq!(parse_shell_path_output("\x1ePATH=\x1e"), None);
        assert_eq!(parse_shell_path_output("\x1eOTHER=/usr/bin\x1e"), None);
    }

    #[test]
    fn merge_child_path_env_prepends_shell_path_when_inherited_path_exists() {
        assert_eq!(
            merge_child_path_env("/opt/homebrew/bin:/usr/local/bin", Some("/usr/bin:/bin")),
            "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
        );
    }

    #[test]
    fn merge_child_path_env_uses_shell_path_when_inherited_path_is_empty() {
        assert_eq!(
            merge_child_path_env("/opt/homebrew/bin", Some("")),
            "/opt/homebrew/bin"
        );
        assert_eq!(
            merge_child_path_env("/opt/homebrew/bin", None),
            "/opt/homebrew/bin"
        );
    }
}
