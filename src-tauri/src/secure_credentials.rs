use std::path::Path;

use serde_json::Value;

const SERVICE: &str = "com.llmwiki.app";

pub fn valid_slot(slot: &str) -> bool {
    if matches!(slot, "llm" | "embedding" | "multimodal") {
        return true;
    }
    let Some(id) = slot.strip_prefix("provider:") else {
        return false;
    };
    !id.is_empty()
        && id.len() <= 100
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn validate_slot(slot: &str) -> Result<(), String> {
    if !valid_slot(slot) {
        return Err("Invalid credential slot".to_string());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn read(slot: &str) -> Result<Option<String>, String> {
    validate_slot(slot)?;
    match security_framework::passwords::get_generic_password(SERVICE, slot) {
        Ok(secret) => String::from_utf8(secret)
            .map(Some)
            .map_err(|_| "Secure credential was not valid UTF-8".to_string()),
        Err(error) if error.code() == -25300 => Ok(None), // errSecItemNotFound
        Err(error) => Err(format!("Could not read secure credential: {error}")),
    }
}

#[cfg(not(target_os = "macos"))]
fn read(slot: &str) -> Result<Option<String>, String> {
    validate_slot(slot)?;
    Ok(None)
}

#[tauri::command]
pub fn secure_credential_set(slot: String, secret: String) -> Result<(), String> {
    if secret.is_empty() {
        return secure_credential_delete(slot);
    }
    validate_slot(&slot)?;
    set_native(&slot, &secret)
}

#[cfg(target_os = "macos")]
fn set_native(slot: &str, secret: &str) -> Result<(), String> {
    security_framework::passwords::set_generic_password(SERVICE, slot, secret.as_bytes())
        .map_err(|error| format!("Could not save secure credential: {error}"))
}

#[cfg(not(target_os = "macos"))]
fn set_native(_slot: &str, _secret: &str) -> Result<(), String> {
    Err("OS secure credential storage is currently supported on macOS".to_string())
}

#[tauri::command]
pub fn secure_credential_get(slot: String) -> Result<Option<String>, String> {
    read(&slot)
}

#[tauri::command]
pub fn secure_credential_delete(slot: String) -> Result<(), String> {
    validate_slot(&slot)?;
    delete_native(&slot)
}

#[cfg(target_os = "macos")]
fn delete_native(slot: &str) -> Result<(), String> {
    match security_framework::passwords::delete_generic_password(SERVICE, slot) {
        Ok(()) => Ok(()),
        Err(error) if error.code() == -25300 => Ok(()), // errSecItemNotFound
        Err(error) => Err(format!("Could not delete secure credential: {error}")),
    }
}

#[cfg(not(target_os = "macos"))]
fn delete_native(_slot: &str) -> Result<(), String> {
    Ok(())
}

fn set_api_key(value: &mut Value, secret: Option<String>) {
    let Some(secret) = secret else { return };
    let Some(object) = value.as_object_mut() else {
        return;
    };
    object.insert("apiKey".to_string(), Value::String(secret));
}

pub fn migrate_legacy_credentials_with(
    state: &mut Value,
    mut write: impl FnMut(&str, &str) -> Result<(), String>,
) -> Result<bool, String> {
    let mut credentials = Vec::new();
    for (key, slot) in [
        ("llmConfig", "llm"),
        ("embeddingConfig", "embedding"),
        ("multimodalConfig", "multimodal"),
    ] {
        if let Some(secret) = state
            .get(key)
            .and_then(|config| config.get("apiKey"))
            .and_then(Value::as_str)
            .filter(|secret| !secret.is_empty())
        {
            credentials.push((slot.to_string(), secret.to_string()));
        }
    }
    if let Some(providers) = state.get("providerConfigs").and_then(Value::as_object) {
        for (id, config) in providers {
            if let Some(secret) = config
                .get("apiKey")
                .and_then(Value::as_str)
                .filter(|secret| !secret.is_empty())
            {
                credentials.push((format!("provider:{id}"), secret.to_string()));
            }
        }
    }

    for (slot, secret) in &credentials {
        validate_slot(slot)?;
        write(slot, secret)?;
    }
    if credentials.is_empty() {
        return Ok(false);
    }

    for key in ["llmConfig", "embeddingConfig", "multimodalConfig"] {
        if let Some(config) = state.get_mut(key) {
            set_api_key(config, Some(String::new()));
        }
    }
    if let Some(providers) = state
        .get_mut("providerConfigs")
        .and_then(Value::as_object_mut)
    {
        for config in providers.values_mut() {
            set_api_key(config, Some(String::new()));
        }
    }
    Ok(true)
}

pub fn migrate_legacy_app_state_file(path: &Path) -> Result<bool, String> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(format!(
                "Could not read app state for credential migration: {error}"
            ))
        }
    };
    let mut state = serde_json::from_str::<Value>(&raw)
        .map_err(|error| format!("Could not parse app state for credential migration: {error}"))?;
    let changed =
        migrate_legacy_credentials_with(&mut state, |slot, secret| set_native(slot, secret))?;
    if !changed {
        return Ok(false);
    }

    let sanitized = serde_json::to_vec(&state)
        .map_err(|error| format!("Could not serialize sanitized app state: {error}"))?;
    let temporary = path.with_extension("credentials-migration.tmp");
    std::fs::write(&temporary, sanitized)
        .map_err(|error| format!("Could not write sanitized app state: {error}"))?;
    std::fs::rename(&temporary, path).map_err(|error| {
        format!("Could not replace app state after credential migration: {error}")
    })?;
    Ok(true)
}

pub fn hydrate_app_state_with(state: &mut Value, mut lookup: impl FnMut(&str) -> Option<String>) {
    for (key, slot) in [
        ("llmConfig", "llm"),
        ("embeddingConfig", "embedding"),
        ("multimodalConfig", "multimodal"),
    ] {
        if let Some(config) = state.get_mut(key) {
            set_api_key(config, lookup(slot));
        }
    }

    if let Some(providers) = state
        .get_mut("providerConfigs")
        .and_then(Value::as_object_mut)
    {
        for (id, config) in providers {
            set_api_key(config, lookup(&format!("provider:{id}")));
        }
    }
}

pub fn hydrate_app_state(state: &mut Value) {
    // Runtime config loading is best-effort: a locked or unavailable OS
    // credential service must not prevent keyless local providers from
    // starting. Explicit Settings reads still return the actionable keyring
    // error through the Tauri command above.
    hydrate_app_state_with(state, |slot| read(slot).ok().flatten());
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    #[test]
    fn accepts_only_application_owned_credential_slots() {
        assert!(valid_slot("llm"));
        assert!(valid_slot("embedding"));
        assert!(valid_slot("multimodal"));
        assert!(valid_slot("provider:openai"));
        assert!(valid_slot("provider:custom-123"));

        assert!(!valid_slot("provider:"));
        assert!(!valid_slot("provider:../../login"));
        assert!(!valid_slot("arbitrary"));
        assert!(!valid_slot(&format!("provider:{}", "a".repeat(101))));
    }

    #[test]
    fn hydrates_runtime_configs_without_changing_public_fields() {
        let mut state = json!({
            "llmConfig": { "provider": "openai", "apiKey": "", "model": "gpt-4o-mini" },
            "embeddingConfig": { "enabled": true, "apiKey": "", "model": "text-embedding-3-small" },
            "multimodalConfig": { "enabled": true, "apiKey": "", "model": "gpt-4o-mini" },
            "providerConfigs": {
                "openai": { "apiKey": "", "model": "gpt-4o-mini" },
                "ollama": { "apiKey": "", "baseUrl": "http://127.0.0.1:11434/v1" }
            }
        });
        let secrets = HashMap::from([
            ("llm".to_string(), "llm-key".to_string()),
            ("embedding".to_string(), "embedding-key".to_string()),
            ("multimodal".to_string(), "vision-key".to_string()),
            ("provider:openai".to_string(), "preset-key".to_string()),
        ]);

        hydrate_app_state_with(&mut state, |slot| secrets.get(slot).cloned());

        assert_eq!(state["llmConfig"]["apiKey"], "llm-key");
        assert_eq!(state["embeddingConfig"]["apiKey"], "embedding-key");
        assert_eq!(state["multimodalConfig"]["apiKey"], "vision-key");
        assert_eq!(state["providerConfigs"]["openai"]["apiKey"], "preset-key");
        assert_eq!(state["providerConfigs"]["ollama"]["apiKey"], "");
        assert_eq!(state["llmConfig"]["model"], "gpt-4o-mini");
    }

    #[test]
    fn migrates_legacy_plaintext_only_after_every_secure_write_succeeds() {
        let mut state = json!({
            "llmConfig": { "apiKey": "llm-key", "model": "gpt-4o-mini" },
            "providerConfigs": {
                "openai": { "apiKey": "preset-key", "model": "gpt-4o-mini" }
            }
        });
        let mut written = HashMap::new();

        let changed = migrate_legacy_credentials_with(&mut state, |slot, secret| {
            written.insert(slot.to_string(), secret.to_string());
            Ok(())
        })
        .unwrap();

        assert!(changed);
        assert_eq!(written.get("llm").map(String::as_str), Some("llm-key"));
        assert_eq!(
            written.get("provider:openai").map(String::as_str),
            Some("preset-key")
        );
        assert_eq!(state["llmConfig"]["apiKey"], "");
        assert_eq!(state["providerConfigs"]["openai"]["apiKey"], "");
    }

    #[test]
    fn failed_legacy_migration_keeps_plaintext_for_lossless_retry() {
        let mut state = json!({
            "embeddingConfig": { "apiKey": "legacy-key", "model": "embed" }
        });
        let original = state.clone();

        let result = migrate_legacy_credentials_with(&mut state, |_slot, _secret| {
            Err("keychain locked".to_string())
        });

        assert!(result.is_err());
        assert_eq!(state, original);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn stores_and_deletes_a_real_keychain_credential() {
        let slot = format!("provider:test-{}", uuid::Uuid::new_v4());
        let _ = secure_credential_delete(slot.clone());

        secure_credential_set(slot.clone(), "temporary-test-secret".to_string()).unwrap();
        assert_eq!(
            secure_credential_get(slot.clone()).unwrap().as_deref(),
            Some("temporary-test-secret")
        );

        secure_credential_delete(slot.clone()).unwrap();
        assert_eq!(secure_credential_get(slot).unwrap(), None);
    }
}
