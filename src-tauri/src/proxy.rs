//! Global outbound HTTP proxy plumbing.
//!
//! At app launch we read the user-set proxy config out of the same
//! `app-state.json` the frontend's tauri-plugin-store writes, and
//! translate it into HTTP_PROXY / HTTPS_PROXY / NO_PROXY environment
//! variables. reqwest (used by tauri-plugin-http) reads those env
//! vars on client construction and routes every outbound request
//! through the configured proxy.
//!
//! Reading the on-disk JSON directly (rather than going through a
//! Rust binding to plugin-store) keeps this module independent of
//! plugin lifecycle: we only need a stable file path and serde.
//! Cost is one duplicated key name (`proxyConfig`) — see
//! src/lib/project-store.ts for the matching write site.

use std::path::Path;

use serde::{Deserialize, Serialize};

const DEFAULT_BYPASS_LIST: &str =
    "localhost,127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,*.local";

#[derive(Debug, Serialize, Deserialize)]
pub struct ProxyConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub url: String,
    #[serde(default = "default_true", rename = "bypassLocal")]
    pub bypass_local: bool,
}

// Hand-written Default impl so its `bypass_local` matches what
// serde produces for a missing field — `derive(Default)` would
// give `false`, which would silently disagree with the
// "missing-key means bypass on" semantics encoded by the serde
// `default = "default_true"` attribute. No caller invokes
// `ProxyConfig::default()` today, but pinning the two paths to
// the same value avoids a footgun if one ever does.
impl Default for ProxyConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            url: String::new(),
            bypass_local: true,
        }
    }
}

fn default_true() -> bool {
    true
}

/// Read `proxyConfig` out of the project's `app-state.json`. Returns
/// None if the file doesn't exist, can't be parsed, or has no proxy
/// section — caller treats those identically to "no proxy".
pub fn read_proxy_config_from_store(store_path: &Path) -> Option<ProxyConfig> {
    let content = std::fs::read_to_string(store_path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    let proxy = json.get("proxyConfig")?;
    serde_json::from_value(proxy.clone()).ok()
}

/// Apply a proxy config by setting the env vars reqwest reads.
/// Returns a short human-readable summary for logging.
///
/// Validates the URL scheme — only `http://` and `https://` are
/// accepted in this version. Anything else (SOCKS5, malformed,
/// missing scheme) is treated as "disabled" so the user doesn't
/// silently trip over a half-working proxy.
///
/// Concurrency note: `std::env::set_var` mutates process-wide
/// state and is racy if any other thread reads env at the same
/// instant. Two callers exist: (1) the Tauri setup hook, which
/// runs before any HTTP client thread starts (safe), and (2)
/// the `set_proxy_env` IPC command, which can race with an
/// in-flight `reqwest::Client::new()` reading HTTP_PROXY. The
/// race window is microseconds and the worst case is one fetch
/// reading the previous value — acceptable for a user-initiated
/// toggle, and matches what every other "global proxy switch"
/// in similar apps does. Documented here so a future Rust
/// edition that hard-fails on this pattern doesn't surprise us.
pub fn apply_proxy_env(config: &ProxyConfig) -> String {
    // Every "disabled" path MUST clear all three env vars, not just
    // return — otherwise toggling the proxy off after it was on
    // leaves the previous values in place and reqwest keeps routing
    // through the now-removed proxy. The same applies to invalid
    // URLs and unsupported schemes (treat as disabled).
    let url = config.url.trim();
    let invalid_scheme = !url.starts_with("http://") && !url.starts_with("https://");

    if !config.enabled || url.is_empty() || invalid_scheme {
        clear_proxy_env();
        return if !config.enabled {
            "disabled".to_string()
        } else if url.is_empty() {
            "disabled (empty url)".to_string()
        } else {
            // Mask before logging — an invalid URL might still
            // contain a password the user mis-typed.
            format!("disabled (unsupported scheme: {})", redact_url(url))
        };
    }

    std::env::set_var("HTTP_PROXY", url);
    std::env::set_var("HTTPS_PROXY", url);
    if config.bypass_local {
        std::env::set_var("NO_PROXY", DEFAULT_BYPASS_LIST);
    } else {
        // Bypass off — clear NO_PROXY so a previously-set value
        // doesn't leak through.
        std::env::remove_var("NO_PROXY");
    }
    format!(
        "enabled ({}, bypass_local={})",
        redact_url(url),
        config.bypass_local
    )
}

/// Strip embedded basic-auth credentials from a URL before logging.
/// `http://user:pass@host:port` → `http://***@host:port`. URLs
/// without credentials pass through untouched. Used so stderr /
/// Console.app / journalctl output doesn't persist proxy
/// passwords.
fn redact_url(url: &str) -> String {
    // Find `scheme://` then check for `user[:pass]@` between that
    // and the next `/` (or end). If found, replace with `***@`.
    let scheme_end = match url.find("://") {
        Some(i) => i + 3,
        None => return url.to_string(),
    };
    let after_scheme = &url[scheme_end..];
    // The userinfo segment, if present, is up to the first '@'
    // that comes BEFORE the first '/'. A '@' after a '/' is part
    // of the path and must not be matched.
    let path_start = after_scheme.find('/').unwrap_or(after_scheme.len());
    let userinfo_end = match after_scheme[..path_start].find('@') {
        Some(i) => i,
        None => return url.to_string(), // no credentials embedded
    };
    let mut out = String::with_capacity(url.len());
    out.push_str(&url[..scheme_end]);
    out.push_str("***");
    out.push_str(&after_scheme[userinfo_end..]);
    out
}

/// Remove all three proxy env vars. Called whenever the user
/// disables the proxy or supplies an invalid URL — this is what
/// makes "turn off proxy" actually take effect for the next fetch
/// (without it, the previous HTTP_PROXY / HTTPS_PROXY / NO_PROXY
/// stay set in the process env and reqwest keeps using them).
fn clear_proxy_env() {
    std::env::remove_var("HTTP_PROXY");
    std::env::remove_var("HTTPS_PROXY");
    std::env::remove_var("NO_PROXY");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Cargo runs tests in parallel by default and these tests all
    /// touch the same process-wide env vars. Without serializing
    /// them, one test's set_var leaks into another test's
    /// assertion. A single mutex shared across the test module
    /// forces them to run one at a time without bringing in a
    /// `serial_test` dependency.
    static ENV_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Run a closure with the proxy-related env vars cleared (and
    /// serialized via ENV_MUTEX), then restore whatever was there
    /// before — keeps tests from contaminating each other or the
    /// host shell.
    fn isolated<F: FnOnce()>(f: F) {
        // Recover from poison — a panic in one test leaves the
        // mutex poisoned, but we have no shared state inside it
        // so resuming with the inner () is safe.
        let _guard = ENV_MUTEX.lock().unwrap_or_else(|p| p.into_inner());
        let snap = (
            std::env::var("HTTP_PROXY").ok(),
            std::env::var("HTTPS_PROXY").ok(),
            std::env::var("NO_PROXY").ok(),
        );
        std::env::remove_var("HTTP_PROXY");
        std::env::remove_var("HTTPS_PROXY");
        std::env::remove_var("NO_PROXY");

        f();

        match snap.0 {
            Some(v) => std::env::set_var("HTTP_PROXY", v),
            None => std::env::remove_var("HTTP_PROXY"),
        }
        match snap.1 {
            Some(v) => std::env::set_var("HTTPS_PROXY", v),
            None => std::env::remove_var("HTTPS_PROXY"),
        }
        match snap.2 {
            Some(v) => std::env::set_var("NO_PROXY", v),
            None => std::env::remove_var("NO_PROXY"),
        }
    }

    #[test]
    fn disabled_sets_no_env() {
        isolated(|| {
            let s = apply_proxy_env(&ProxyConfig {
                enabled: false,
                url: "http://x:1".into(),
                bypass_local: true,
            });
            assert!(s.contains("disabled"));
            assert!(std::env::var("HTTP_PROXY").is_err());
            assert!(std::env::var("HTTPS_PROXY").is_err());
        });
    }

    #[test]
    fn enabled_sets_both_proxy_envs() {
        isolated(|| {
            apply_proxy_env(&ProxyConfig {
                enabled: true,
                url: "http://127.0.0.1:7890".into(),
                bypass_local: true,
            });
            assert_eq!(
                std::env::var("HTTP_PROXY").unwrap(),
                "http://127.0.0.1:7890"
            );
            assert_eq!(
                std::env::var("HTTPS_PROXY").unwrap(),
                "http://127.0.0.1:7890"
            );
            let no_proxy = std::env::var("NO_PROXY").unwrap();
            assert!(no_proxy.contains("localhost"));
            assert!(no_proxy.contains("127.0.0.0/8"));
            assert!(no_proxy.contains("192.168.0.0/16"));
        });
    }

    #[test]
    fn bypass_local_off_clears_no_proxy() {
        isolated(|| {
            std::env::set_var("NO_PROXY", "stale-value");
            apply_proxy_env(&ProxyConfig {
                enabled: true,
                url: "http://x:1".into(),
                bypass_local: false,
            });
            // The stale value must be cleared so the user's intent
            // (everything goes through the proxy) is honored.
            assert!(std::env::var("NO_PROXY").is_err());
        });
    }

    #[test]
    fn rejects_unsupported_schemes() {
        isolated(|| {
            apply_proxy_env(&ProxyConfig {
                enabled: true,
                url: "socks5://x:1".into(),
                bypass_local: true,
            });
            assert!(std::env::var("HTTP_PROXY").is_err());
        });
    }

    #[test]
    fn rejects_empty_url() {
        isolated(|| {
            apply_proxy_env(&ProxyConfig {
                enabled: true,
                url: "   ".into(),
                bypass_local: true,
            });
            assert!(std::env::var("HTTP_PROXY").is_err());
        });
    }

    #[test]
    fn disable_after_enable_clears_previously_set_env_vars() {
        // Regression: if the user enabled the proxy, then disables
        // it, the next request must NOT keep going through the
        // (now-removed) proxy. apply_proxy_env's "disabled" path
        // must actively unset HTTP_PROXY / HTTPS_PROXY / NO_PROXY,
        // not just return without writing.
        isolated(|| {
            apply_proxy_env(&ProxyConfig {
                enabled: true,
                url: "http://127.0.0.1:7890".into(),
                bypass_local: true,
            });
            assert_eq!(
                std::env::var("HTTP_PROXY").unwrap(),
                "http://127.0.0.1:7890",
            );

            apply_proxy_env(&ProxyConfig {
                enabled: false,
                url: "http://127.0.0.1:7890".into(),
                bypass_local: true,
            });
            assert!(std::env::var("HTTP_PROXY").is_err());
            assert!(std::env::var("HTTPS_PROXY").is_err());
            assert!(std::env::var("NO_PROXY").is_err());
        });
    }

    #[test]
    fn unsupported_scheme_after_enable_clears_env() {
        // Same regression class for invalid-URL changes — switching
        // the URL to something we won't apply (socks5://) must clear
        // any previously-applied http(s) values, not silently keep
        // them.
        isolated(|| {
            apply_proxy_env(&ProxyConfig {
                enabled: true,
                url: "http://127.0.0.1:7890".into(),
                bypass_local: true,
            });
            apply_proxy_env(&ProxyConfig {
                enabled: true,
                url: "socks5://x:1".into(),
                bypass_local: true,
            });
            assert!(std::env::var("HTTP_PROXY").is_err());
        });
    }

    #[test]
    fn https_proxy_url_is_supported() {
        isolated(|| {
            apply_proxy_env(&ProxyConfig {
                enabled: true,
                url: "https://proxy.corp:443".into(),
                bypass_local: false,
            });
            assert_eq!(
                std::env::var("HTTPS_PROXY").unwrap(),
                "https://proxy.corp:443"
            );
        });
    }

    #[test]
    fn redacts_basic_auth_credentials_in_url() {
        assert_eq!(
            redact_url("http://user:pass@proxy.corp:8080"),
            "http://***@proxy.corp:8080",
        );
        // URL with path after host: '@' in path must not be matched
        assert_eq!(
            redact_url("http://user:pass@proxy.corp:8080/some@path"),
            "http://***@proxy.corp:8080/some@path",
        );
        // Username only (no password)
        assert_eq!(
            redact_url("http://user@proxy.corp:8080"),
            "http://***@proxy.corp:8080",
        );
        // No credentials — pass through
        assert_eq!(
            redact_url("http://proxy.corp:8080"),
            "http://proxy.corp:8080",
        );
        // No scheme at all (defensive — invalid URL shouldn't crash)
        assert_eq!(redact_url("garbage"), "garbage");
    }

    #[test]
    fn apply_proxy_env_summary_does_not_leak_password() {
        isolated(|| {
            let summary = apply_proxy_env(&ProxyConfig {
                enabled: true,
                url: "http://secretuser:secretpass@proxy.corp:8080".into(),
                bypass_local: true,
            });
            assert!(!summary.contains("secretpass"));
            assert!(!summary.contains("secretuser"));
            assert!(summary.contains("***"));
            assert!(summary.contains("proxy.corp:8080"));
        });
    }

    #[test]
    fn default_trait_matches_serde_missing_field_semantics() {
        // Regression: derive(Default) makes bypass_local = false, but
        // serde with `default = "default_true"` makes a missing field
        // = true. The two must agree so a ProxyConfig::default() and
        // a serde-deserialized empty `{}` produce identical values.
        let default_via_trait = ProxyConfig::default();
        let default_via_serde: ProxyConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(default_via_trait.enabled, default_via_serde.enabled);
        assert_eq!(default_via_trait.url, default_via_serde.url);
        assert_eq!(
            default_via_trait.bypass_local, default_via_serde.bypass_local,
            "Default trait and serde-default must agree on bypass_local",
        );
        // And both should be the safe default: bypass on, proxy off.
        assert!(!default_via_trait.enabled);
        assert!(default_via_trait.bypass_local);
    }

    #[test]
    fn parses_camelcase_bypassLocal_field() {
        // Frontend writes `bypassLocal` (camelCase). We must accept
        // that exact spelling — verify the serde rename works.
        let json = r#"{"enabled": true, "url": "http://x:1", "bypassLocal": false}"#;
        let cfg: ProxyConfig = serde_json::from_str(json).unwrap();
        assert!(cfg.enabled);
        assert_eq!(cfg.url, "http://x:1");
        assert!(!cfg.bypass_local);
    }

    #[test]
    fn missing_proxyConfig_returns_none() {
        let dir = tempdir_for_test();
        let path = dir.join("missing.json");
        assert!(read_proxy_config_from_store(&path).is_none());
    }

    #[test]
    fn parses_proxy_config_from_store_file() {
        let dir = tempdir_for_test();
        let path = dir.join("app-state.json");
        std::fs::write(
            &path,
            r#"{"proxyConfig": {"enabled": true, "url": "http://x:1", "bypassLocal": true}}"#,
        )
        .unwrap();
        let cfg = read_proxy_config_from_store(&path).unwrap();
        assert!(cfg.enabled);
        assert_eq!(cfg.url, "http://x:1");
    }

    #[test]
    fn ignores_store_file_with_no_proxy_section() {
        let dir = tempdir_for_test();
        let path = dir.join("app-state.json");
        std::fs::write(&path, r#"{"otherKey": "value"}"#).unwrap();
        assert!(read_proxy_config_from_store(&path).is_none());
    }

    fn tempdir_for_test() -> std::path::PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("llm-wiki-proxy-test-{stamp}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
