//! OS-backed secret storage (Keychain / Credential Manager / Secret Service).

use keyring::Entry;
use serde_json::Value;
use tauri::{AppHandle, Manager};

pub const API_TOKEN_KEY: &str = "api_token";
const SERVICE_NAME: &str = "llm-wiki";

fn entry(key: &str) -> Result<Entry, String> {
    Entry::new(SERVICE_NAME, key).map_err(|e| format!("keyring entry error: {e}"))
}

pub fn store_secret(key: &str, value: &str) -> Result<(), String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return delete_secret(key);
    }
    entry(key)?
        .set_password(trimmed)
        .map_err(|e| format!("failed to store secret '{key}': {e}"))
}

pub fn get_secret(key: &str) -> Result<String, String> {
    entry(key)?
        .get_password()
        .map_err(|e| format!("failed to read secret '{key}': {e}"))
}

pub fn delete_secret(key: &str) -> Result<(), String> {
    match entry(key)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("failed to delete secret '{key}': {e}")),
    }
}

/// Move plaintext `apiConfig.token` from app-state.json into the OS keychain.
pub fn migrate_api_token_from_app_state(app: &AppHandle) -> Result<bool, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?
        .join("app-state.json");
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(_) => return Ok(false),
    };
    let mut parsed: Value =
        serde_json::from_str(&raw).map_err(|e| format!("invalid app-state.json: {e}"))?;
    let Some(token) = parsed
        .get("apiConfig")
        .and_then(|v| v.get("token"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    else {
        return Ok(false);
    };

    if get_secret(API_TOKEN_KEY).is_ok() {
        if let Some(api) = parsed.get_mut("apiConfig").and_then(Value::as_object_mut) {
            api.insert("token".to_string(), Value::String(String::new()));
            std::fs::write(&path, serde_json::to_string_pretty(&parsed).unwrap_or(raw))
                .map_err(|e| format!("failed to strip migrated token: {e}"))?;
        }
        return Ok(false);
    }

    store_secret(API_TOKEN_KEY, token)?;
    if let Some(api) = parsed.get_mut("apiConfig").and_then(Value::as_object_mut) {
        api.insert("token".to_string(), Value::String(String::new()));
    }
    std::fs::write(
        &path,
        serde_json::to_string_pretty(&parsed).unwrap_or_else(|_| raw),
    )
    .map_err(|e| format!("failed to update app-state.json after migration: {e}"))?;
    crate::local_auth::invalidate_config_cache();
    Ok(true)
}

#[tauri::command]
pub fn secrets_store_command(key: String, value: String) -> Result<(), String> {
    store_secret(&key, &value)
}

#[tauri::command]
pub fn secrets_delete_command(key: String) -> Result<(), String> {
    delete_secret(&key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_secret_when_keychain_available() {
        let key = format!(
            "test-roundtrip-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        if store_secret(&key, "hello-secret").is_err() {
            // Headless CI may lack a keychain — skip rather than fail the suite.
            return;
        }
        let Ok(value) = get_secret(&key) else {
            // Some macOS/CI keychain backends accept writes but don't roundtrip synchronously.
            let _ = delete_secret(&key);
            return;
        };
        assert_eq!(value, "hello-secret");
        delete_secret(&key).unwrap();
        assert!(get_secret(&key).is_err());
    }
}
