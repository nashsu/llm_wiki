//! Downloads and caches an official Node.js runtime when `node` isn't
//! found on PATH, so the remote MCP bridge (remote_mcp.rs) works without
//! asking the user to install anything manually. Cached under
//! `<app_data_dir>/node-runtime/<version>/` — checked before falling back
//! to a PATH lookup or a fresh download.

use std::io::Cursor;
use std::path::{Path, PathBuf};

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use super::cli_resolver::find_cli_command;

// Used only if the version-index fetch below fails (offline, nodejs.org
// unreachable) — a reasonably recent LTS so the download path still has a
// chance of working rather than failing outright.
const FALLBACK_VERSION: &str = "22.11.0";

fn platform_target() -> Result<(&'static str, &'static str), String> {
    let (os, arch) = (std::env::consts::OS, std::env::consts::ARCH);
    match (os, arch) {
        ("linux", "x86_64") => Ok(("linux-x64", "tar.gz")),
        ("linux", "aarch64") => Ok(("linux-arm64", "tar.gz")),
        ("macos", "x86_64") => Ok(("darwin-x64", "tar.gz")),
        ("macos", "aarch64") => Ok(("darwin-arm64", "tar.gz")),
        ("windows", "x86_64") => Ok(("win-x64", "zip")),
        ("windows", "aarch64") => Ok(("win-arm64", "zip")),
        _ => Err(format!(
            "No automatic Node.js download available for {os}/{arch} — install Node.js 20+ manually and reopen Settings."
        )),
    }
}

fn install_root(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not resolve app data directory: {e}"))?;
    Ok(base.join("node-runtime"))
}

/// Node.js archives extract to a top-level `node-v<version>-<platform>/`
/// folder; the binary lives at `bin/node` (Unix) or `node.exe` (Windows,
/// no bin/ subfolder). Walk one level rather than hardcoding that folder
/// name, so this stays robust if Node.js ever changes its archive naming.
fn node_binary_in(dir: &Path) -> Option<PathBuf> {
    for candidate in [dir.join("bin").join("node"), dir.join("node.exe")] {
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        for candidate in [path.join("bin").join("node"), path.join("node.exe")] {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Scans `node-runtime/*` for any already-downloaded version, regardless of
/// which one — so a launch after the first successful download never needs
/// a network round-trip (unlike re-resolving "latest" on every start,
/// which would also mean silently upgrading the bridge's Node runtime out
/// from under a working setup).
fn find_any_cached_node(root: &Path) -> Option<PathBuf> {
    for entry in std::fs::read_dir(root).ok()?.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(bin) = node_binary_in(&path) {
                return Some(bin);
            }
        }
    }
    None
}

/// Resolution order: already-downloaded copy (any version) → PATH → download
/// the current Node.js LTS now.
pub async fn ensure_node(app: &AppHandle) -> Result<PathBuf, String> {
    let root = install_root(app)?;
    if let Some(cached) = find_any_cached_node(&root) {
        return Ok(cached);
    }
    if let Ok(path) = find_cli_command("node", &["node.exe"]).await {
        return Ok(path);
    }
    let version = resolve_latest_lts_version().await;
    let dir = root.join(&version);
    download_and_extract(app, &dir, &version).await?;
    node_binary_in(&dir).ok_or_else(|| {
        "Downloaded Node.js but could not locate the node binary inside the extracted archive."
            .to_string()
    })
}

/// The current Node.js LTS ("Long Term Support" — what "latest stable"
/// means for Node; the non-LTS "Current" line churns much faster and isn't
/// what you want for an unattended background service). `index.json` lists
/// every release, newest first; each entry's `lts` field is either `false`
/// or the LTS codename string, so the first entry with a truthy `lts` is
/// the newest stable release.
async fn resolve_latest_lts_version() -> String {
    let response = match reqwest::get("https://nodejs.org/dist/index.json").await {
        Ok(r) if r.status().is_success() => r,
        _ => return FALLBACK_VERSION.to_string(),
    };
    let entries: Vec<Value> = match response.json().await {
        Ok(v) => v,
        Err(_) => return FALLBACK_VERSION.to_string(),
    };
    entries
        .iter()
        .find(|entry| !matches!(entry.get("lts"), Some(Value::Bool(false)) | None))
        .and_then(|entry| entry.get("version"))
        .and_then(Value::as_str)
        .map(|v| v.trim_start_matches('v').to_string())
        .unwrap_or_else(|| FALLBACK_VERSION.to_string())
}

async fn download_and_extract(app: &AppHandle, dir: &Path, version: &str) -> Result<(), String> {
    let (platform, ext) = platform_target()?;
    let url = format!("https://nodejs.org/dist/v{version}/node-v{version}-{platform}.{ext}");
    let _ = app.emit("remote-mcp:log", format!("No Node.js found — downloading v{version} from {url}…"));

    let response = reqwest::get(&url)
        .await
        .map_err(|e| format!("Failed to download Node.js from {url}: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Failed to download Node.js: HTTP {} from {url}",
            response.status()
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read Node.js download body: {e}"))?;

    std::fs::create_dir_all(dir).map_err(|e| format!("Failed to create {}: {e}", dir.display()))?;

    if ext == "zip" {
        extract_zip(&bytes, dir)?;
    } else {
        extract_tar_gz(&bytes, dir)?;
    }

    let _ = app.emit("remote-mcp:log", "Node.js runtime ready.".to_string());
    Ok(())
}

/// tar's unpack() preserves the executable bit from the archive metadata —
/// Node's official tarballs mark bin/node executable, so no manual chmod
/// is needed here (unlike the zip path below, which is Windows-only where
/// unix executable bits don't apply).
fn extract_tar_gz(bytes: &[u8], dest: &Path) -> Result<(), String> {
    let decoder = flate2::read::GzDecoder::new(Cursor::new(bytes));
    let mut archive = tar::Archive::new(decoder);
    archive
        .unpack(dest)
        .map_err(|e| format!("Failed to extract Node.js tar.gz archive: {e}"))
}

fn extract_zip(bytes: &[u8], dest: &Path) -> Result<(), String> {
    let mut archive =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("Failed to open Node.js zip archive: {e}"))?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("Failed to read zip entry {index}: {e}"))?;
        let Some(rel) = entry.enclosed_name() else {
            continue; // reject any entry zip-slip protection can't validate
        };
        let target = dest.join(rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&target).map_err(|e| format!("Failed to create {}: {e}", target.display()))?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
        }
        let mut out = std::fs::File::create(&target).map_err(|e| format!("Failed to create {}: {e}", target.display()))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("Failed to write {}: {e}", target.display()))?;
    }
    Ok(())
}
