//! Shared local HTTP authentication for the API server (19828) and Clip server (19827).

use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::observability;
use crate::secrets_store;

const APP_STATE_CACHE_TTL: Duration = Duration::from_secs(5);

#[derive(Clone)]
struct CachedAppState {
    loaded_at: Instant,
    value: Option<Value>,
}

static APP_STATE_CACHE: OnceLock<Mutex<Option<CachedAppState>>> = OnceLock::new();

pub fn invalidate_config_cache() {
    if let Some(lock) = APP_STATE_CACHE.get() {
        if let Ok(mut cache) = lock.lock() {
            *cache = None;
        }
    }
}

pub fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let max_len = left.len().max(right.len());
    let mut diff = left.len() ^ right.len();
    for i in 0..max_len {
        let a = left.get(i).copied().unwrap_or(0);
        let b = right.get(i).copied().unwrap_or(0);
        diff |= (a ^ b) as usize;
    }
    diff == 0
}

pub fn api_token(app: &AppHandle) -> Option<String> {
    if let Ok(token) = std::env::var("LLM_WIKI_API_TOKEN") {
        let trimmed = token.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    if let Ok(token) = secrets_store::get_secret(secrets_store::API_TOKEN_KEY) {
        if !token.trim().is_empty() {
            return Some(token);
        }
    }
    load_app_state(app)
        .and_then(|parsed| {
            parsed
                .get("apiConfig")
                .and_then(|v| v.get("token"))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(ToOwned::to_owned)
        })
}

pub fn api_token_source(app: &AppHandle) -> &'static str {
    if let Ok(token) = std::env::var("LLM_WIKI_API_TOKEN") {
        if !token.trim().is_empty() {
            return "env";
        }
    }
    if secrets_store::get_secret(secrets_store::API_TOKEN_KEY)
        .map(|t| !t.trim().is_empty())
        .unwrap_or(false)
    {
        return "keychain";
    }
    if load_app_state(app)
        .and_then(|parsed| {
            parsed
                .get("apiConfig")
                .and_then(|v| v.get("token"))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(|_| ())
        })
        .is_some()
    {
        return "store";
    }
    "none"
}

pub fn api_allow_unauthenticated(app: &AppHandle) -> bool {
    let Some(parsed) = load_app_state(app) else {
        return false;
    };
    parsed
        .get("apiConfig")
        .and_then(|v| v.get("allowUnauthenticated"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

pub fn api_auth_required(app: &AppHandle) -> bool {
    !api_allow_unauthenticated(app)
}

pub fn api_enabled(app: &AppHandle) -> bool {
    let Some(parsed) = load_app_state(app) else {
        return true;
    };
    parsed
        .get("apiConfig")
        .and_then(|v| v.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

pub fn api_mcp_enabled(app: &AppHandle) -> bool {
    let Some(parsed) = load_app_state(app) else {
        return false;
    };
    parsed
        .get("apiConfig")
        .and_then(|v| v.get("mcpEnabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

pub fn is_authorized(app: &AppHandle, headers: &[(String, String)]) -> bool {
    if !api_auth_required(app) {
        return true;
    }
    let Some(token) = api_token(app) else {
        return false;
    };
    headers.iter().any(|(key, value)| {
        if key == "x-llm-wiki-token" {
            return constant_time_eq(value.as_bytes(), token.as_bytes());
        }
        if key == "authorization" {
            return value
                .strip_prefix("Bearer ")
                .map(|v| constant_time_eq(v.as_bytes(), token.as_bytes()))
                .unwrap_or(false);
        }
        false
    })
}

pub fn load_app_state(app: &AppHandle) -> Option<Value> {
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

pub fn app_data_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok()
}

pub fn auth_failure_reason(app: &AppHandle) -> &'static str {
    if !api_auth_required(app) {
        return "auth not required";
    }
    if api_token(app).is_none() {
        "token not configured"
    } else {
        "invalid or missing credentials"
    }
}

pub fn log_auth_denied(component: &str, path: &str, request_id: &str, app: &AppHandle) {
    observability::log_event(
        "warn",
        component,
        "auth_denied",
        &[
            ("path", path),
            ("reason", auth_failure_reason(app)),
        ],
        Some(request_id),
    );
}
