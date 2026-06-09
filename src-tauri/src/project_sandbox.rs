//! Restrict Tauri FS commands to registered wiki project roots (+ app data dir).

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};

static REGISTERED_ROOTS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
static APP_DATA_ROOT: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

fn roots_lock() -> &'static Mutex<HashSet<PathBuf>> {
    REGISTERED_ROOTS.get_or_init(|| Mutex::new(HashSet::new()))
}

pub fn set_app_data_root(path: PathBuf) {
    let lock = APP_DATA_ROOT.get_or_init(|| Mutex::new(None));
    if let Ok(mut guard) = lock.lock() {
        *guard = Some(path);
    }
}

pub fn register_project_root(path: &str) -> Result<(), String> {
    let canonical = canonicalize_existing_or_parent(path)?;
    let mut guard = roots_lock()
        .lock()
        .map_err(|_| "project sandbox lock poisoned".to_string())?;
    guard.insert(canonical);
    Ok(())
}

pub fn unregister_project_root(path: &str) {
    if let Ok(canonical) = canonicalize_existing_or_parent(path) {
        if let Ok(mut guard) = roots_lock().lock() {
            guard.remove(&canonical);
        }
    }
}

pub fn clear_project_roots() {
    if let Ok(mut guard) = roots_lock().lock() {
        guard.clear();
    }
}

#[cfg(test)]
pub fn reset_for_tests() {
    clear_project_roots();
    if let Some(lock) = APP_DATA_ROOT.get() {
        if let Ok(mut guard) = lock.lock() {
            *guard = None;
        }
    }
}

fn canonicalize_existing_or_parent(path: &str) -> Result<PathBuf, String> {
    let path = Path::new(path.trim());
    if path.as_os_str().is_empty() {
        return Err("path is empty".to_string());
    }
    if path.exists() {
        return path
            .canonicalize()
            .map_err(|e| format!("failed to canonicalize '{}': {e}", path.display()));
    }
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| format!("path has no parent: '{}'", path.display()))?;
    if !parent.exists() {
        return Err(format!("parent path does not exist: '{}'", parent.display()));
    }
    let parent_canon = parent
        .canonicalize()
        .map_err(|e| format!("failed to canonicalize parent '{}': {e}", parent.display()))?;
    Ok(parent_canon.join(
        path.file_name()
            .ok_or_else(|| format!("path has no file name: '{}'", path.display()))?,
    ))
}

fn is_within_root(candidate: &Path, root: &Path) -> bool {
    candidate == root || candidate.starts_with(root)
}

pub fn validate_sandboxed_path(operation: &str, path: &str) -> Result<PathBuf, String> {
    if !is_absolute_path_cross_platform(path) {
        return Err(format!(
            "{operation} requires an absolute path; got relative path '{path}'"
        ));
    }
    let rel = path.trim_start_matches('/');
    let rel_path = Path::new(rel);
    for component in rel_path.components() {
        if matches!(
            component,
            Component::ParentDir | Component::Prefix(_) | Component::RootDir
        ) {
            return Err(format!("{operation}: path traversal is not allowed"));
        }
    }

    let resolved = canonicalize_existing_or_parent(path)?;
    let roots = roots_lock()
        .lock()
        .map_err(|_| "project sandbox lock poisoned".to_string())?;
    for root in roots.iter() {
        if is_within_root(&resolved, root) {
            return Ok(resolved);
        }
    }
    if let Some(lock) = APP_DATA_ROOT.get() {
        if let Ok(guard) = lock.lock() {
            if let Some(app_data) = guard.as_ref() {
                if is_within_root(&resolved, app_data) {
                    return Ok(resolved);
                }
            }
        }
    }
    Err(format!(
        "{operation}: path '{}' is outside registered project directories",
        path
    ))
}

fn is_absolute_path_cross_platform(path: &str) -> bool {
    if path.is_empty() {
        return false;
    }
    if Path::new(path).is_absolute() {
        return true;
    }
    let bytes = path.as_bytes();
    if bytes.len() >= 3
        && bytes[1] == b':'
        && bytes[0].is_ascii_alphabetic()
        && matches!(bytes[2], b'/' | b'\\')
    {
        return true;
    }
    path.starts_with(r"\\") || path.starts_with("//")
}

#[tauri::command]
pub fn register_sandbox_project(path: String) -> Result<(), String> {
    register_project_root(&path)
}

#[tauri::command]
pub fn unregister_sandbox_project(path: String) -> Result<(), String> {
    unregister_project_root(&path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir() -> PathBuf {
        let id = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("llm-wiki-sandbox-{id}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn rejects_paths_outside_registered_roots() {
        reset_for_tests();
        let root = temp_dir();
        let wiki = root.join("wiki");
        fs::create_dir_all(&wiki).unwrap();
        register_project_root(root.to_str().unwrap()).unwrap();

        let outside = temp_dir();
        fs::write(outside.join("outside.txt"), "secret").unwrap();
        assert!(validate_sandboxed_path(
            "read_file",
            outside.join("outside.txt").to_str().unwrap()
        )
        .is_err());

        let inside = wiki.join("index.md");
        fs::write(&inside, "ok").unwrap();
        assert!(validate_sandboxed_path("read_file", inside.to_str().unwrap()).is_ok());

        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
        reset_for_tests();
    }
}
