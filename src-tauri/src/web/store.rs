//! Key/value settings store for web mode.
//!
//! The desktop app persists settings with `tauri-plugin-store` into
//! `<app_data_dir>/app-state.json` — a single JSON object. The Rust side
//! (`api_server`, `app_commands`) already reads that file directly, so web
//! mode writes the exact same file: the frontend's `store.get/set` calls are
//! bridged to [`get`] / [`set`] over RPC and every other reader keeps working
//! unchanged.

use std::fs;
use std::path::Path;
use std::sync::Mutex;

use serde_json::{Map, Value};

static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn read_object(path: &Path) -> Map<String, Value> {
    match fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str::<Value>(&raw)
            .ok()
            .and_then(|v| match v {
                Value::Object(map) => Some(map),
                _ => None,
            })
            .unwrap_or_default(),
        Err(_) => Map::new(),
    }
}

fn write_object(path: &Path, map: &Map<String, Value>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create data dir: {e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    let raw = serde_json::to_string(&Value::Object(map.clone()))
        .map_err(|e| format!("Failed to serialize store: {e}"))?;
    fs::write(&tmp, raw).map_err(|e| format!("Failed to write store: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("Failed to replace store: {e}"))?;
    Ok(())
}

pub fn get(path: &Path, key: &str) -> Value {
    read_object(path).get(key).cloned().unwrap_or(Value::Null)
}

pub fn entries(path: &Path) -> Map<String, Value> {
    read_object(path)
}

pub fn set(path: &Path, key: &str, value: Value) -> Result<(), String> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut map = read_object(path);
    if value.is_null() {
        map.remove(key);
    } else {
        map.insert(key.to_string(), value);
    }
    write_object(path, &map)
}

pub fn delete(path: &Path, key: &str) -> Result<bool, String> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut map = read_object(path);
    let existed = map.remove(key).is_some();
    write_object(path, &map)?;
    Ok(existed)
}

pub fn clear(path: &Path) -> Result<(), String> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    write_object(path, &Map::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let dir = std::env::temp_dir().join(format!("llm-wiki-store-{}", uuid::Uuid::new_v4()));
        let path = dir.join("app-state.json");
        assert_eq!(get(&path, "a"), Value::Null);
        set(&path, "a", serde_json::json!({"x": 1})).unwrap();
        assert_eq!(get(&path, "a")["x"], 1);
        assert!(delete(&path, "a").unwrap());
        assert_eq!(get(&path, "a"), Value::Null);
        let _ = fs::remove_dir_all(dir);
    }
}
