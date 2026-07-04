use std::fs;

use serde_json::Value;
use tauri::{AppHandle, Manager};

const DEFAULT_BIND_HOST: &str = "127.0.0.1";
const PUBLIC_BIND_HOST: &str = "0.0.0.0";
const BIND_HOST_ENV: &str = "LLM_WIKI_BIND_HOST";

pub fn configured_bind_host(app: &AppHandle) -> String {
    configured_env_bind_host()
        .or_else(|| configured_store_bind_host(app))
        .unwrap_or_else(|| DEFAULT_BIND_HOST.to_string())
}

fn configured_env_bind_host() -> Option<String> {
    std::env::var(BIND_HOST_ENV)
        .ok()
        .and_then(|value| sanitize_bind_host(&value))
}

fn configured_store_bind_host(app: &AppHandle) -> Option<String> {
    let path = app.path().app_data_dir().ok()?.join("app-state.json");
    let raw = fs::read_to_string(path).ok()?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    if allow_lan_access_from_state(&parsed) {
        Some(PUBLIC_BIND_HOST.to_string())
    } else {
        None
    }
}

pub fn bind_addr(host: &str, port: u16) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

fn sanitize_bind_host(value: &str) -> Option<String> {
    let host = value.trim();
    if host.is_empty() {
        return None;
    }
    let valid = host
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_' | ':' | '[' | ']'));
    if valid {
        Some(host.to_string())
    } else {
        None
    }
}

fn allow_lan_access_from_state(value: &Value) -> bool {
    value
        .get("apiConfig")
        .and_then(|config| config.get("allowLanAccess"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{allow_lan_access_from_state, bind_addr, sanitize_bind_host};

    #[test]
    fn sanitize_bind_host_accepts_common_lan_hosts() {
        assert_eq!(sanitize_bind_host("0.0.0.0"), Some("0.0.0.0".to_string()));
        assert_eq!(
            sanitize_bind_host("  192.168.1.10  "),
            Some("192.168.1.10".to_string())
        );
        assert_eq!(sanitize_bind_host("::1"), Some("::1".to_string()));
        assert_eq!(sanitize_bind_host("[::]"), Some("[::]".to_string()));
    }

    #[test]
    fn sanitize_bind_host_rejects_empty_or_address_injection() {
        assert_eq!(sanitize_bind_host(""), None);
        assert_eq!(sanitize_bind_host("0.0.0.0:19828/path"), None);
        assert_eq!(sanitize_bind_host("127.0.0.1;rm"), None);
    }

    #[test]
    fn bind_addr_wraps_unbracketed_ipv6_hosts() {
        assert_eq!(bind_addr("127.0.0.1", 19828), "127.0.0.1:19828");
        assert_eq!(bind_addr("0.0.0.0", 19828), "0.0.0.0:19828");
        assert_eq!(bind_addr("::1", 19828), "[::1]:19828");
        assert_eq!(bind_addr("[::]", 19828), "[::]:19828");
    }

    #[test]
    fn allow_lan_access_reads_api_config_flag() {
        assert!(allow_lan_access_from_state(&json!({
            "apiConfig": { "allowLanAccess": true }
        })));
        assert!(!allow_lan_access_from_state(&json!({
            "apiConfig": { "allowLanAccess": false }
        })));
        assert!(!allow_lan_access_from_state(&json!({})));
    }
}
