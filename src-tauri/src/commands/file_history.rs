use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

const MAX_HISTORY_CONTENT_BYTES: usize = 512 * 1024;
const MAX_ENTRIES_PER_FILE: usize = 30;
const MAX_HISTORY_STORE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_HISTORY_STORE_FILES: usize = 2_048;
static HISTORY_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHistoryEntry {
    pub id: String,
    pub path: String,
    pub timestamp: i64,
    pub author: String,
    pub tool: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHistoryStats {
    pub bytes: u64,
    pub files: usize,
    pub entries: usize,
}

/// Return provenance only, never historical content, for Agent retrieval
/// briefings. Reading the same bounded store as the timeline keeps attribution
/// consistent without expanding prompt size or exposing rollback snapshots.
pub fn latest_file_version(path: &Path) -> Option<(i64, String, String)> {
    let root = project_root_for(path)?;
    let _guard = HISTORY_LOCK.lock().ok()?;
    checked_history_dir(&root, false).ok()?;
    let raw = fs::read_to_string(history_path(&root, path)).ok()?;
    let entries: Vec<FileHistoryEntry> = serde_json::from_str(&raw).ok()?;
    entries
        .last()
        .map(|entry| (entry.timestamp, entry.author.clone(), entry.tool.clone()))
}

fn project_root_for(path: &Path) -> Option<PathBuf> {
    let mut cursor = path.parent();
    while let Some(dir) = cursor {
        if dir.join(".llm-wiki").is_dir() {
            return Some(dir.to_path_buf());
        }
        cursor = dir.parent();
    }
    None
}

fn history_path(root: &Path, path: &Path) -> PathBuf {
    let relative = path.strip_prefix(root).unwrap_or(path).to_string_lossy();
    // Fixed FNV-1a keeps history addresses stable across Rust/toolchain upgrades.
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in relative.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    let key = format!("{hash:016x}");
    root.join(".llm-wiki/history").join(format!("{key}.json"))
}

fn history_dir(root: &Path) -> PathBuf {
    root.join(".llm-wiki/history")
}

fn checked_history_dir(root: &Path, create: bool) -> Result<PathBuf, String> {
    let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
    let metadata_dir = canonical_root.join(".llm-wiki");
    let metadata = fs::symlink_metadata(&metadata_dir).map_err(|e| e.to_string())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("History metadata directory must be a real project directory".to_string());
    }

    let dir = metadata_dir.join("history");
    if create {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    } else if !dir.exists() {
        return Ok(dir);
    }
    let dir_metadata = fs::symlink_metadata(&dir).map_err(|e| e.to_string())?;
    if !dir_metadata.is_dir() || dir_metadata.file_type().is_symlink() {
        return Err("History directory must not be a symlink".to_string());
    }
    let canonical_dir = dir.canonicalize().map_err(|e| e.to_string())?;
    if !canonical_dir.starts_with(&metadata_dir) {
        return Err("History directory must stay inside the project".to_string());
    }
    Ok(canonical_dir)
}

fn history_files_oldest_first(root: &Path) -> Vec<(PathBuf, u64, std::time::SystemTime)> {
    let Ok(entries) = fs::read_dir(history_dir(root)) else {
        return Vec::new();
    };
    let mut files: Vec<_> = entries
        .flatten()
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            if !metadata.is_file()
                || entry.path().extension().and_then(|ext| ext.to_str()) != Some("json")
            {
                return None;
            }
            Some((
                entry.path(),
                metadata.len(),
                metadata
                    .modified()
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH),
            ))
        })
        .collect();
    files.sort_by_key(|(_, _, modified)| *modified);
    files
}

fn prune_history_store(root: &Path, protected_path: &Path) {
    let files = history_files_oldest_first(root);
    let mut total_bytes = files.iter().map(|(_, bytes, _)| *bytes).sum::<u64>();
    let mut total_files = files.len();
    for (path, bytes, _) in files {
        if total_bytes <= MAX_HISTORY_STORE_BYTES && total_files <= MAX_HISTORY_STORE_FILES {
            break;
        }
        if path == protected_path {
            continue;
        }
        if fs::remove_file(&path).is_ok() {
            total_bytes = total_bytes.saturating_sub(bytes);
            total_files = total_files.saturating_sub(1);
        }
    }
}

pub fn record_file_version(path: &Path, author: &str, tool: &str) {
    let Ok(metadata) = fs::metadata(path) else {
        return;
    };
    if !metadata.is_file() || metadata.len() as usize > MAX_HISTORY_CONTENT_BYTES {
        return;
    }
    let Ok(content) = fs::read_to_string(path) else {
        return;
    };
    let Some(root) = project_root_for(path) else {
        return;
    };
    if path.starts_with(root.join(".llm-wiki")) {
        return;
    }
    let Ok(_guard) = HISTORY_LOCK.lock() else {
        return;
    };
    let Ok(dir) = checked_history_dir(&root, true) else {
        return;
    };
    let Some(file_name) = history_path(&root, path).file_name().map(ToOwned::to_owned) else {
        return;
    };
    let store_path = dir.join(file_name);
    let mut entries: Vec<FileHistoryEntry> = fs::read_to_string(&store_path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    if entries.last().is_some_and(|entry| entry.content == content) {
        return;
    }
    entries.push(FileHistoryEntry {
        id: Uuid::new_v4().to_string(),
        path: path.to_string_lossy().replace('\\', "/"),
        timestamp: Utc::now().timestamp_millis(),
        author: author.to_string(),
        tool: tool.to_string(),
        content,
    });
    if entries.len() > MAX_ENTRIES_PER_FILE {
        entries.drain(..entries.len() - MAX_ENTRIES_PER_FILE);
    }
    if let Ok(raw) = serde_json::to_string(&entries) {
        if fs::write(&store_path, raw).is_ok() {
            prune_history_store(&root, &store_path);
        }
    }
}

fn checked_project_root(project_path: &str) -> Result<PathBuf, String> {
    let root = Path::new(project_path)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !root.join(".llm-wiki").is_dir() {
        return Err("History project must contain .llm-wiki".to_string());
    }
    Ok(root)
}

fn checked_file(project_path: &str, file_path: &str) -> Result<(PathBuf, PathBuf), String> {
    let root = Path::new(project_path)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let file = Path::new(file_path)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !file.starts_with(&root) || file.starts_with(root.join(".llm-wiki")) {
        return Err("History path must stay inside the project".to_string());
    }
    Ok((root, file))
}

#[tauri::command]
pub async fn list_file_history(
    project_path: String,
    file_path: String,
) -> Result<Vec<FileHistoryEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (root, file) = checked_file(&project_path, &file_path)?;
        let _guard = HISTORY_LOCK.lock().map_err(|e| e.to_string())?;
        checked_history_dir(&root, false)?;
        let raw =
            fs::read_to_string(history_path(&root, &file)).unwrap_or_else(|_| "[]".to_string());
        let mut entries: Vec<FileHistoryEntry> = serde_json::from_str(&raw).unwrap_or_default();
        entries.reverse();
        Ok(entries)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn restore_file_history(
    project_path: String,
    file_path: String,
    entry_id: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (root, file) = checked_file(&project_path, &file_path)?;
        let content = {
            let _guard = HISTORY_LOCK.lock().map_err(|e| e.to_string())?;
            checked_history_dir(&root, false)?;
            let raw = fs::read_to_string(history_path(&root, &file)).map_err(|e| e.to_string())?;
            let entries: Vec<FileHistoryEntry> =
                serde_json::from_str(&raw).map_err(|e| e.to_string())?;
            let entry = entries
                .into_iter()
                .find(|entry| entry.id == entry_id)
                .ok_or_else(|| "History entry not found".to_string())?;
            fs::write(&file, &entry.content).map_err(|e| e.to_string())?;
            entry.content
        };
        record_file_version(&file, "human", "history.restore");
        Ok(content)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_file_history_stats(project_path: String) -> Result<FileHistoryStats, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = checked_project_root(&project_path)?;
        let _guard = HISTORY_LOCK.lock().map_err(|e| e.to_string())?;
        checked_history_dir(&root, false)?;
        let files = history_files_oldest_first(&root);
        let entries = files
            .iter()
            .filter_map(|(path, _, _)| fs::read_to_string(path).ok())
            .filter_map(|raw| serde_json::from_str::<Vec<FileHistoryEntry>>(&raw).ok())
            .map(|entries| entries.len())
            .sum();
        Ok(FileHistoryStats {
            bytes: files.iter().map(|(_, bytes, _)| *bytes).sum(),
            files: files.len(),
            entries,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn clear_file_history(project_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = checked_project_root(&project_path)?;
        let _guard = HISTORY_LOCK.lock().map_err(|e| e.to_string())?;
        let dir = checked_history_dir(&root, false)?;
        if dir.exists() {
            fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn records_and_restores_append_only_versions() {
        let root = std::env::temp_dir().join(format!("llm-wiki-history-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join(".llm-wiki")).unwrap();
        fs::create_dir_all(root.join("wiki")).unwrap();
        let file = root.join("wiki/page.md");
        fs::write(&file, "before").unwrap();
        record_file_version(&file, "baseline", "before.test");
        fs::write(&file, "after").unwrap();
        record_file_version(&file, "agent", "test.write");

        let entries = list_file_history(
            root.to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
        )
        .await
        .unwrap();
        assert_eq!(entries.len(), 2);
        let old = entries
            .iter()
            .find(|entry| entry.content == "before")
            .unwrap();
        restore_file_history(
            root.to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
            old.id.clone(),
        )
        .await
        .unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "before");
        let restored = list_file_history(
            root.to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
        )
        .await
        .unwrap();
        assert_eq!(restored.first().unwrap().tool, "history.restore");
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn reports_and_clears_project_history_without_touching_current_files() {
        let root = std::env::temp_dir().join(format!("llm-wiki-history-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join(".llm-wiki")).unwrap();
        fs::create_dir_all(root.join("wiki")).unwrap();
        let file = root.join("wiki/page.md");
        fs::write(&file, "current").unwrap();
        record_file_version(&file, "agent", "test.write");

        let stats = get_file_history_stats(root.to_string_lossy().into_owned())
            .await
            .unwrap();
        assert_eq!(stats.files, 1);
        assert_eq!(stats.entries, 1);
        assert!(stats.bytes > 0);

        clear_file_history(root.to_string_lossy().into_owned())
            .await
            .unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "current");
        let cleared = get_file_history_stats(root.to_string_lossy().into_owned())
            .await
            .unwrap();
        assert_eq!(cleared.files, 0);
        assert_eq!(cleared.entries, 0);
        assert_eq!(cleared.bytes, 0);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_history_directory_symlink_escape() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!("llm-wiki-history-{}", Uuid::new_v4()));
        let outside =
            std::env::temp_dir().join(format!("llm-wiki-history-outside-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join(".llm-wiki")).unwrap();
        fs::create_dir_all(root.join("wiki")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, root.join(".llm-wiki/history")).unwrap();
        let file = root.join("wiki/page.md");
        fs::write(&file, "current").unwrap();

        record_file_version(&file, "agent", "test.write");

        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
    }
}
