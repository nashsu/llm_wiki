//! Git collaboration commands.
//!
//! Uses the system `git` CLI via `std::process::Command` instead of the
//! `git2` crate to avoid a heavy native dependency (libgit2 + libssh2 +
//! openssl).  All commands run inside `spawn_blocking` so they never
//! block the tokio worker threads.

use std::path::Path;
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::panic_guard::run_guarded;

// ── Types ─────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub modified: usize,
    pub untracked: usize,
    pub staged: usize,
    pub branch: String,
    pub has_remote: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CommitEntry {
    pub hash: String,
    pub message: String,
    pub author: String,
    pub date: String,
}

// ── Helpers ───────────────────────────────────────────────────────────

/// Run `git` in `path` with the given args, return stdout on success.
fn git_cmd(path: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(path)
        .env("LC_ALL", "C") // force English output for reliable parsing
        .output()
        .map_err(|e| format!("Failed to spawn git: {}. Is git installed?", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!(
                "git {} failed with status {}",
                args.join(" "),
                output.status
            )
        } else {
            stderr
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Check whether a directory is inside a git repository.
fn is_git_repo(path: &str) -> bool {
    git_cmd(path, &["rev-parse", "--is-inside-work-tree"]).is_ok()
}

// ── Commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn git_init(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("git_init", || {
            if is_git_repo(&path) {
                return Ok("Already a git repository".to_string());
            }
            git_cmd(&path, &["init"])?;
            // Write a sensible .gitignore for wiki projects
            let gitignore = "\
.cache/
.llm-wiki/
.superpowers/
*.tmp
*.bak
.DS_Store
";
            let gi_path = Path::new(&path).join(".gitignore");
            if !gi_path.exists() {
                std::fs::write(&gi_path, gitignore)
                    .map_err(|e| format!("Failed to write .gitignore: {}", e))?;
            }
            Ok("Git repository initialized".to_string())
        })
    })
    .await
    .map_err(|e| format!("git_init blocking task join error: {e}"))?
}

#[tauri::command]
pub async fn git_status(path: String) -> Result<GitStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("git_status", || {
            if !is_git_repo(&path) {
                return Ok(GitStatus {
                    modified: 0,
                    untracked: 0,
                    staged: 0,
                    branch: String::new(),
                    has_remote: false,
                });
            }

            // porcelain v2 gives machine-parseable output
            let output = git_cmd(&path, &["status", "--porcelain=v2", "--branch"])?;

            let mut modified = 0usize;
            let mut untracked = 0usize;
            let mut staged = 0usize;
            let mut branch = String::from("(unknown)");
            let mut has_remote = false;

            for line in output.lines() {
                if line.starts_with("# branch.head ") {
                    branch = line[14..].to_string();
                    if branch == "(detached)" {
                        branch = "(detached HEAD)".to_string();
                    }
                } else if line.starts_with("# branch.upstream ") {
                    has_remote = true;
                } else if line.starts_with("1 ") || line.starts_with("2 ") {
                    // Changed entry -- xy flags at bytes 2..4
                    let xy = line.as_bytes().get(2..4);
                    if let Some(xy) = xy {
                        let x = xy[0] as char;
                        let y = xy[1] as char;
                        // x = index status, y = worktree status
                        match x {
                            '?' | '!' => {}
                            _ => staged += 1,
                        }
                        match y {
                            '?' | '!' | '.' => {}
                            _ => modified += 1,
                        }
                    }
                } else if line.starts_with("u ") {
                    // Unmerged entry -- counts as both staged and modified
                    staged += 1;
                    modified += 1;
                } else if line.starts_with("? ") {
                    untracked += 1;
                }
            }

            Ok(GitStatus {
                modified,
                untracked,
                staged,
                branch,
                has_remote,
            })
        })
    })
    .await
    .map_err(|e| format!("git_status blocking task join error: {e}"))?
}

#[tauri::command]
pub async fn git_commit(path: String, message: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("git_commit", || {
            if !is_git_repo(&path) {
                return Err("Not a git repository. Initialize git first.".to_string());
            }

            // Stage all changes (new, modified, deleted)
            git_cmd(&path, &["add", "-A"])?;

            // Check if there is anything to commit
            let status = git_cmd(&path, &["status", "--porcelain"])?;
            if status.is_empty() {
                return Ok("Nothing to commit".to_string());
            }

            // Commit with the provided message
            // Use -c to avoid editor prompts
            git_cmd(
                &path,
                &[
                    "-c",
                    "user.name=LLM Wiki",
                    "-c",
                    "user.email=wiki@llm-wiki.local",
                    "commit",
                    "-m",
                    &message,
                ],
            )?;

            Ok(format!("Committed: {}", message))
        })
    })
    .await
    .map_err(|e| format!("git_commit blocking task join error: {e}"))?
}

#[tauri::command]
pub async fn git_push(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("git_push", || {
            if !is_git_repo(&path) {
                return Err("Not a git repository. Initialize git first.".to_string());
            }
            git_cmd(&path, &["push", "origin", "HEAD"]).map(|_| "Pushed successfully".to_string())
        })
    })
    .await
    .map_err(|e| format!("git_push blocking task join error: {e}"))?
}

#[tauri::command]
pub async fn git_pull(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("git_pull", || {
            if !is_git_repo(&path) {
                return Err("Not a git repository. Initialize git first.".to_string());
            }
            git_cmd(&path, &["pull", "--rebase"]).map(|_| "Pulled successfully".to_string())
        })
    })
    .await
    .map_err(|e| format!("git_pull blocking task join error: {e}"))?
}

#[tauri::command]
pub async fn git_log(path: String, count: u32) -> Result<Vec<CommitEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("git_log", || {
            if !is_git_repo(&path) {
                return Ok(vec![]);
            }
            let count_str = count.to_string();
            let output = git_cmd(
                &path,
                &[
                    "log",
                    &format!("-{}", count_str),
                    "--pretty=format:%H%x00%s%x00%an%x00%ai",
                ],
            )?;

            let entries = output
                .lines()
                .filter(|l| !l.is_empty())
                .map(|line| {
                    let parts: Vec<&str> = line.split('\0').collect();
                    CommitEntry {
                        hash: parts.first().unwrap_or(&"").to_string(),
                        message: parts.get(1).unwrap_or(&"").to_string(),
                        author: parts.get(2).unwrap_or(&"").to_string(),
                        date: parts
                            .get(3)
                            .unwrap_or(&"")
                            .split(' ')
                            .next()
                            .unwrap_or("")
                            .to_string(),
                    }
                })
                .collect();

            Ok(entries)
        })
    })
    .await
    .map_err(|e| format!("git_log blocking task join error: {e}"))?
}

#[tauri::command]
pub async fn git_set_remote(path: String, url: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("git_set_remote", || {
            if !is_git_repo(&path) {
                return Err("Not a git repository. Initialize git first.".to_string());
            }
            // Check if origin already exists
            let has_origin = git_cmd(&path, &["remote", "get-url", "origin"]).is_ok();
            if has_origin {
                git_cmd(&path, &["remote", "set-url", "origin", &url])?;
            } else {
                git_cmd(&path, &["remote", "add", "origin", &url])?;
            }
            Ok(())
        })
    })
    .await
    .map_err(|e| format!("git_set_remote blocking task join error: {e}"))?
}
