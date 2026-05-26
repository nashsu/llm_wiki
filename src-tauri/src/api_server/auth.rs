use std::fs;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::common::parse_query;
use super::APP_STATE_CACHE_TTL;

#[derive(Clone)]
struct CachedAppState {
    loaded_at: Instant,
    value: Option<Value>,
}

static APP_STATE_CACHE: OnceLock<Mutex<Option<CachedAppState>>> = OnceLock::new();

pub(super) fn invalidate_config_cache() {
    if let Some(lock) = APP_STATE_CACHE.get() {
        if let Ok(mut cache) = lock.lock() {
            *cache = None;
        }
    }
}

pub(super) fn is_authorized(app: &AppHandle, query: &str, headers: &[(String, String)]) -> bool {
    if !api_auth_required(app) {
        return true;
    }
    let Some(token) = api_token(app) else {
        return false;
    };
    let params = parse_query(query);
    if params
        .get("token")
        .map(|value| constant_time_eq(value.as_bytes(), token.as_bytes()))
        .unwrap_or(false)
    {
        return true;
    }
    headers.iter().any(|(key, value)| {
        if key == "x-llm-wiki-token" {
            return constant_time_eq(value.as_bytes(), token.as_bytes());
        }
        if key == "authorization" {
            return value
                .strip_prefix("Bearer ")
                .map(|value| constant_time_eq(value.as_bytes(), token.as_bytes()))
                .unwrap_or(false);
        }
        false
    })
}

pub(super) fn api_token(app: &AppHandle) -> Option<String> {
    if let Ok(token) = std::env::var("LLM_WIKI_API_TOKEN") {
        let trimmed = token.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    let parsed = load_app_state(app)?;
    api_config_token(&parsed)
}

pub(super) fn api_token_source(app: &AppHandle) -> &'static str {
    if let Ok(token) = std::env::var("LLM_WIKI_API_TOKEN") {
        if !token.trim().is_empty() {
            return "env";
        }
    }
    if load_app_state(app)
        .and_then(|parsed| api_config_token(&parsed).map(|_| ()))
        .is_some()
    {
        return "store";
    }
    "none"
}

pub(super) fn api_auth_required(app: &AppHandle) -> bool {
    !api_allow_unauthenticated(app)
}

pub(super) fn api_allow_unauthenticated(app: &AppHandle) -> bool {
    let Some(parsed) = load_app_state(app) else {
        return false;
    };
    api_config_bool(&parsed, "allowUnauthenticated", false)
}

pub(super) fn api_enabled(app: &AppHandle) -> bool {
    let Some(parsed) = load_app_state(app) else {
        return true;
    };
    api_config_bool(&parsed, "enabled", true)
}

pub(super) fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let max_len = left.len().max(right.len());
    let mut diff = left.len() ^ right.len();
    for i in 0..max_len {
        let a = left.get(i).copied().unwrap_or(0);
        let b = right.get(i).copied().unwrap_or(0);
        diff |= (a ^ b) as usize;
    }
    diff == 0
}

pub(super) fn load_app_state(app: &AppHandle) -> Option<Value> {
    let now = Instant::now();
    let lock = APP_STATE_CACHE.get_or_init(|| Mutex::new(None));
    let mut previous = None;
    if let Ok(cache) = lock.lock() {
        if let Some(cached) = cache.as_ref() {
            if now.duration_since(cached.loaded_at) < APP_STATE_CACHE_TTL {
                return cached.value.clone();
            }
            previous = cached.value.clone();
        }
    }

    let path = app.path().app_data_dir().ok()?.join("app-state.json");
    let loaded = fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
    let value = loaded.or(previous);

    if let Ok(mut cache) = lock.lock() {
        *cache = Some(CachedAppState {
            loaded_at: now,
            value: value.clone(),
        });
    }
    value
}

fn api_config_token(parsed: &Value) -> Option<String> {
    parsed
        .get("apiConfig")
        .and_then(|value| value.get("token"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn api_config_bool(parsed: &Value, key: &str, default: bool) -> bool {
    parsed
        .get("apiConfig")
        .and_then(|value| value.get(key))
        .and_then(Value::as_bool)
        .unwrap_or(default)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn api_config_token_reads_only_non_empty_store_tokens() {
        let payload = json!({ "apiConfig": { "token": "abc" } });
        assert_eq!(api_config_token(&payload).as_deref(), Some("abc"));

        let empty = json!({ "apiConfig": { "token": "" } });
        assert_eq!(api_config_token(&empty), None);

        let missing = json!({});
        assert_eq!(api_config_token(&missing), None);
    }

    #[test]
    fn api_config_bool_honors_defaults_and_explicit_values() {
        let payload = json!({
            "apiConfig": {
                "enabled": false,
                "allowUnauthenticated": true
            }
        });
        assert!(!api_config_bool(&payload, "enabled", true));
        assert!(api_config_bool(&payload, "allowUnauthenticated", false));

        let missing = json!({});
        assert!(api_config_bool(&missing, "enabled", true));
        assert!(!api_config_bool(&missing, "allowUnauthenticated", false));
    }

    #[test]
    fn constant_time_eq_matches_equal_bytes_only() {
        assert!(constant_time_eq(b"token", b"token"));
        assert!(constant_time_eq(b"", b""));
        assert!(!constant_time_eq(b"token", b"tokeN"));
        assert!(!constant_time_eq(b"token", b"token-longer"));
    }
}
