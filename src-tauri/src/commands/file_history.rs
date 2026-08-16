use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

const MAX_HISTORY_CONTENT_BYTES: usize = 512 * 1024;
const DEFAULT_ENTRIES_PER_FILE: usize = 10;
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct FileHistorySettings {
    pub enabled: bool,
    pub max_versions_per_file: usize,
}

impl Default for FileHistorySettings {
    fn default() -> Self {
        Self {
            enabled: false,
            max_versions_per_file: DEFAULT_ENTRIES_PER_FILE,
        }
    }
}

impl FileHistorySettings {
    fn normalized(mut self) -> Self {
        self.max_versions_per_file = self.max_versions_per_file.min(MAX_ENTRIES_PER_FILE);
        self
    }
}

fn history_settings_path(root: &Path) -> PathBuf {
    root.join(".llm-wiki/history-settings.json")
}

fn validate_optional_regular_file(path: &Path, label: &str) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => Ok(()),
        Ok(_) => Err(format!("{label} must be a regular file, not a symlink")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn read_history_settings(root: &Path) -> FileHistorySettings {
    let path = history_settings_path(root);
    if validate_optional_regular_file(&path, "History settings").is_err() {
        return FileHistorySettings::default();
    }
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<FileHistorySettings>(&raw).ok())
        .unwrap_or_default()
        .normalized()
}

/// Return provenance only, never historical content, for Agent retrieval
/// briefings. Reading the same bounded store as the timeline keeps attribution
/// consistent without expanding prompt size or exposing rollback snapshots.
pub fn latest_file_version(path: &Path) -> Option<(i64, String, String)> {
    let root = project_root_for(path)?;
    let _guard = HISTORY_LOCK.lock().ok()?;
    checked_history_dir(&root, false).ok()?;
    let store_path = checked_history_file(&root, path).ok()?;
    let raw = fs::read_to_string(store_path).ok()?;
    let entries: Vec<FileHistoryEntry> = serde_json::from_str(&raw).ok()?;
    entries
        .last()
        .map(|entry| (entry.timestamp, entry.author.clone(), entry.tool.clone()))
}

fn project_root_for(path: &Path) -> Option<PathBuf> {
    let mut cursor = path.parent();
    while let Some(dir) = cursor {
        let metadata_dir = dir.join(".llm-wiki");
        if fs::symlink_metadata(&metadata_dir)
            .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
        {
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

fn checked_history_file(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let store_path = history_path(root, path);
    validate_optional_regular_file(&store_path, "History file")?;
    Ok(store_path)
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
            let file_type = entry.file_type().ok()?;
            if !file_type.is_file() || file_type.is_symlink() {
                return None;
            }
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

fn prune_entries_per_file(root: &Path, max_versions: usize) -> Result<(), String> {
    let dir = checked_history_dir(root, false)?;
    if !dir.exists() {
        return Ok(());
    }
    if max_versions == 0 {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
        return Ok(());
    }
    for (path, _, _) in history_files_oldest_first(root) {
        let raw = match fs::read_to_string(&path) {
            Ok(raw) => raw,
            Err(_) => continue,
        };
        let mut entries: Vec<FileHistoryEntry> = match serde_json::from_str(&raw) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        if entries.len() > max_versions {
            entries.drain(..entries.len() - max_versions);
            let serialized = serde_json::to_string(&entries).map_err(|e| e.to_string())?;
            fs::write(&path, serialized).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub fn record_file_version(path: &Path, author: &str, tool: &str) {
    let Some(root) = project_root_for(path) else {
        return;
    };
    if path.starts_with(root.join(".llm-wiki")) {
        return;
    }
    let Ok(_guard) = HISTORY_LOCK.lock() else {
        return;
    };
    let settings = read_history_settings(&root);
    if !settings.enabled || settings.max_versions_per_file == 0 {
        return;
    }
    let Ok(metadata) = fs::metadata(path) else {
        return;
    };
    if !metadata.is_file() || metadata.len() as usize > MAX_HISTORY_CONTENT_BYTES {
        return;
    }
    let Ok(content) = fs::read_to_string(path) else {
        return;
    };
    let Ok(dir) = checked_history_dir(&root, true) else {
        return;
    };
    let Ok(checked_store_path) = checked_history_file(&root, path) else {
        return;
    };
    let Some(file_name) = checked_store_path.file_name().map(ToOwned::to_owned) else {
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
    if entries.len() > settings.max_versions_per_file {
        entries.drain(..entries.len() - settings.max_versions_per_file);
    }
    if let Ok(raw) = serde_json::to_string(&entries) {
        if fs::write(&store_path, raw).is_ok() {
            prune_history_store(&root, &store_path);
        }
    }
}

#[tauri::command]
pub async fn get_file_history_settings(
    project_path: String,
) -> Result<FileHistorySettings, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = checked_project_root(&project_path)?;
        Ok(read_history_settings(&root))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn set_file_history_settings(
    project_path: String,
    settings: FileHistorySettings,
) -> Result<FileHistorySettings, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = checked_project_root(&project_path)?;
        let mut settings = settings.normalized();
        if settings.enabled && settings.max_versions_per_file == 0 {
            settings.max_versions_per_file = DEFAULT_ENTRIES_PER_FILE;
        }
        let _guard = HISTORY_LOCK.lock().map_err(|e| e.to_string())?;
        let previous = read_history_settings(&root);
        let settings_path = history_settings_path(&root);
        let had_settings = validate_optional_regular_file(&settings_path, "History settings")
            .is_ok()
            && fs::read_to_string(&settings_path)
                .ok()
                .and_then(|raw| serde_json::from_str::<FileHistorySettings>(&raw).ok())
                .is_some();
        let raw = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
        validate_optional_regular_file(&settings_path, "History settings")?;
        fs::write(settings_path, raw).map_err(|e| e.to_string())?;
        if !had_settings || settings.max_versions_per_file < previous.max_versions_per_file {
            prune_entries_per_file(&root, settings.max_versions_per_file)?;
        }
        Ok(settings)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn checked_project_root(project_path: &str) -> Result<PathBuf, String> {
    let root = Path::new(project_path)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let metadata = fs::symlink_metadata(root.join(".llm-wiki")).map_err(|e| e.to_string())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
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
        let store_path = checked_history_file(&root, &file)?;
        let raw = fs::read_to_string(store_path).unwrap_or_else(|_| "[]".to_string());
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
            let store_path = checked_history_file(&root, &file)?;
            let raw = fs::read_to_string(&store_path).map_err(|e| e.to_string())?;
            let mut entries: Vec<FileHistoryEntry> =
                serde_json::from_str(&raw).map_err(|e| e.to_string())?;
            let entry = entries
                .iter()
                .find(|entry| entry.id == entry_id)
                .cloned()
                .ok_or_else(|| "History entry not found".to_string())?;
            let current = fs::read_to_string(&file).map_err(|e| e.to_string())?;
            if current.len() > MAX_HISTORY_CONTENT_BYTES {
                return Err(format!(
                    "Current file is too large to back up safely before restore (maximum {} bytes)",
                    MAX_HISTORY_CONTENT_BYTES
                ));
            }
            if current != entry.content
                && !entries
                    .last()
                    .is_some_and(|existing| existing.content == current)
            {
                entries.push(FileHistoryEntry {
                    id: Uuid::new_v4().to_string(),
                    path: file.to_string_lossy().replace('\\', "/"),
                    timestamp: Utc::now().timestamp_millis(),
                    author: "human".to_string(),
                    tool: "before.history.restore".to_string(),
                    content: current,
                });
                let retention = read_history_settings(&root).max_versions_per_file.max(1);
                if entries.len() > retention {
                    entries.drain(..entries.len() - retention);
                }
                let updated = serde_json::to_string(&entries).map_err(|e| e.to_string())?;
                fs::write(&store_path, updated).map_err(|e| e.to_string())?;
                prune_history_store(&root, &store_path);
            }
            fs::write(&file, &entry.content).map_err(|e| e.to_string())?;
            entry.content
        };
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

    fn enable_history(root: &Path, max_versions_per_file: usize) {
        let settings = FileHistorySettings {
            enabled: true,
            max_versions_per_file,
        };
        fs::write(
            history_settings_path(root),
            serde_json::to_string(&settings).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn history_is_disabled_by_default() {
        let root = std::env::temp_dir().join(format!("llm-wiki-history-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join(".llm-wiki")).unwrap();
        fs::create_dir_all(root.join("wiki")).unwrap();
        let file = root.join("wiki/page.md");
        fs::write(&file, "current").unwrap();

        record_file_version(&file, "agent", "test.write");

        assert!(!history_dir(&root).exists());
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn records_and_restores_append_only_versions() {
        let root = std::env::temp_dir().join(format!("llm-wiki-history-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join(".llm-wiki")).unwrap();
        fs::create_dir_all(root.join("wiki")).unwrap();
        enable_history(&root, 10);
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
        assert_eq!(restored.first().unwrap().content, "after");
        assert_eq!(restored.first().unwrap().tool, "test.write");
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn reports_and_clears_project_history_without_touching_current_files() {
        let root = std::env::temp_dir().join(format!("llm-wiki-history-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join(".llm-wiki")).unwrap();
        fs::create_dir_all(root.join("wiki")).unwrap();
        enable_history(&root, 10);
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
        enable_history(&root, 10);
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, root.join(".llm-wiki/history")).unwrap();
        let file = root.join("wiki/page.md");
        fs::write(&file, "current").unwrap();

        record_file_version(&file, "agent", "test.write");

        assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn refuses_metadata_directory_symlink_escape_for_settings() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!("llm-wiki-history-{}", Uuid::new_v4()));
        let outside =
            std::env::temp_dir().join(format!("llm-wiki-history-outside-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, root.join(".llm-wiki")).unwrap();

        let result = set_file_history_settings(
            root.to_string_lossy().into_owned(),
            FileHistorySettings {
                enabled: true,
                max_versions_per_file: 10,
            },
        )
        .await;

        assert!(result.is_err());
        assert!(!outside.join("history-settings.json").exists());
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn refuses_symlinked_settings_and_history_files() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!("llm-wiki-history-{}", Uuid::new_v4()));
        let outside =
            std::env::temp_dir().join(format!("llm-wiki-history-outside-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join(".llm-wiki/history")).unwrap();
        fs::create_dir_all(root.join("wiki")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let outside_settings = outside.join("settings.json");
        fs::write(&outside_settings, "untouched settings").unwrap();
        symlink(&outside_settings, history_settings_path(&root)).unwrap();

        let settings_result = set_file_history_settings(
            root.to_string_lossy().into_owned(),
            FileHistorySettings {
                enabled: true,
                max_versions_per_file: 10,
            },
        )
        .await;
        assert!(settings_result.is_err());
        assert_eq!(
            fs::read_to_string(&outside_settings).unwrap(),
            "untouched settings"
        );

        fs::remove_file(history_settings_path(&root)).unwrap();
        enable_history(&root, 10);
        let file = root.join("wiki/page.md");
        fs::write(&file, "current").unwrap();
        let outside_history = outside.join("history.json");
        fs::write(&outside_history, "untouched history").unwrap();
        symlink(&outside_history, history_path(&root, &file)).unwrap();

        record_file_version(&file, "agent", "test.write");
        let list_result = list_file_history(
            root.to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
        )
        .await;
        assert!(list_result.is_err());
        assert_eq!(
            fs::read_to_string(&outside_history).unwrap(),
            "untouched history"
        );
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
    }

    #[tokio::test]
    async fn settings_clamp_and_prune_existing_versions() {
        let root = std::env::temp_dir().join(format!("llm-wiki-history-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join(".llm-wiki")).unwrap();
        fs::create_dir_all(root.join("wiki")).unwrap();
        enable_history(&root, 10);
        let file = root.join("wiki/page.md");
        for version in 0..5 {
            fs::write(&file, format!("version {version}")).unwrap();
            record_file_version(&file, "agent", "test.write");
        }

        let saved = set_file_history_settings(
            root.to_string_lossy().into_owned(),
            FileHistorySettings {
                enabled: true,
                max_versions_per_file: 2,
            },
        )
        .await
        .unwrap();
        assert_eq!(saved.max_versions_per_file, 2);
        let entries = list_file_history(
            root.to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
        )
        .await
        .unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].content, "version 4");

        fs::write(history_dir(&root).join("corrupt.json"), "not json").unwrap();

        set_file_history_settings(
            root.to_string_lossy().into_owned(),
            FileHistorySettings {
                enabled: false,
                max_versions_per_file: 0,
            },
        )
        .await
        .unwrap();
        assert!(!history_path(&root, &file).exists());
        assert!(!history_dir(&root).join("corrupt.json").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn disabled_history_preserves_entries_and_restore_backs_up_current_content() {
        let root = std::env::temp_dir().join(format!("llm-wiki-history-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join(".llm-wiki")).unwrap();
        fs::create_dir_all(root.join("wiki")).unwrap();
        enable_history(&root, 10);
        let file = root.join("wiki/page.md");
        fs::write(&file, "old").unwrap();
        record_file_version(&file, "agent", "test.write");
        let old = list_file_history(
            root.to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
        )
        .await
        .unwrap()
        .remove(0);
        set_file_history_settings(
            root.to_string_lossy().into_owned(),
            FileHistorySettings {
                enabled: false,
                max_versions_per_file: 10,
            },
        )
        .await
        .unwrap();
        fs::write(&file, "unsnapshotted current content").unwrap();
        record_file_version(&file, "agent", "ignored.while.disabled");

        restore_file_history(
            root.to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
            old.id,
        )
        .await
        .unwrap();

        assert_eq!(fs::read_to_string(&file).unwrap(), "old");
        let entries = list_file_history(
            root.to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
        )
        .await
        .unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].content, "unsnapshotted current content");
        assert_eq!(entries[0].tool, "before.history.restore");
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn restore_refuses_when_current_content_is_too_large_to_back_up() {
        let root = std::env::temp_dir().join(format!("llm-wiki-history-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join(".llm-wiki")).unwrap();
        fs::create_dir_all(root.join("wiki")).unwrap();
        enable_history(&root, 10);
        let file = root.join("wiki/page.md");
        fs::write(&file, "old").unwrap();
        record_file_version(&file, "agent", "test.write");
        let old = list_file_history(
            root.to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
        )
        .await
        .unwrap()
        .remove(0);
        let oversized = "x".repeat(MAX_HISTORY_CONTENT_BYTES + 1);
        fs::write(&file, &oversized).unwrap();

        let result = restore_file_history(
            root.to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
            old.id,
        )
        .await;

        assert!(result.is_err());
        assert_eq!(fs::read_to_string(&file).unwrap(), oversized);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn settings_clamp_to_thirty_and_recording_honors_custom_limit() {
        let root = std::env::temp_dir().join(format!("llm-wiki-history-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join(".llm-wiki")).unwrap();
        fs::create_dir_all(root.join("wiki")).unwrap();
        let saved = set_file_history_settings(
            root.to_string_lossy().into_owned(),
            FileHistorySettings {
                enabled: true,
                max_versions_per_file: 100,
            },
        )
        .await
        .unwrap();
        assert_eq!(saved.max_versions_per_file, 30);

        set_file_history_settings(
            root.to_string_lossy().into_owned(),
            FileHistorySettings {
                enabled: true,
                max_versions_per_file: 2,
            },
        )
        .await
        .unwrap();
        let file = root.join("wiki/page.md");
        for version in 0..4 {
            fs::write(&file, format!("version {version}")).unwrap();
            record_file_version(&file, "agent", "test.write");
        }
        let entries = list_file_history(
            root.to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
        )
        .await
        .unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].content, "version 3");
        assert_eq!(entries[1].content, "version 2");
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn first_settings_save_prunes_legacy_history_to_default_limit() {
        let root = std::env::temp_dir().join(format!("llm-wiki-history-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join(".llm-wiki")).unwrap();
        fs::create_dir_all(root.join("wiki")).unwrap();
        enable_history(&root, 30);
        let file = root.join("wiki/page.md");
        for version in 0..15 {
            fs::write(&file, format!("version {version}")).unwrap();
            record_file_version(&file, "agent", "test.write");
        }
        fs::remove_file(history_settings_path(&root)).unwrap();

        set_file_history_settings(
            root.to_string_lossy().into_owned(),
            FileHistorySettings {
                enabled: true,
                max_versions_per_file: 10,
            },
        )
        .await
        .unwrap();

        let entries = list_file_history(
            root.to_string_lossy().into_owned(),
            file.to_string_lossy().into_owned(),
        )
        .await
        .unwrap();
        assert_eq!(entries.len(), 10);
        assert_eq!(entries[0].content, "version 14");
        let _ = fs::remove_dir_all(root);
    }
}
