//! OAuth 2.0 (authorization code + PKCE) for connectors that need it.
//!
//! Bring-your-own client: the user registers an OAuth app with the provider
//! and pastes the client id / secret into the connector's settings. The
//! browser is sent to the provider's consent page; the provider redirects
//! back to a loopback URL served by the local API (desktop) or to
//! `/web/connectors/oauth/callback` on the web server. The callback exchanges
//! the code for tokens and stores them in the secrets file.
//!
//! Redirect URIs to register with the provider:
//!   desktop → `http://127.0.0.1:19828/api/v1/oauth/callback`
//!   web     → `https://<your host>/web/connectors/oauth/callback`

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use super::store;
use super::Secrets;
use crate::app_ctx::AppCtx;

pub struct ProviderDef {
    pub auth_url: &'static str,
    pub token_url: &'static str,
    /// Extra query parameters for the authorization request.
    pub extra_auth_params: &'static [(&'static str, &'static str)],
}

pub fn provider(name: &str) -> Option<ProviderDef> {
    match name {
        "google" => Some(ProviderDef {
            auth_url: "https://accounts.google.com/o/oauth2/v2/auth",
            token_url: "https://oauth2.googleapis.com/token",
            // offline + consent so a refresh token is issued every time.
            extra_auth_params: &[("access_type", "offline"), ("prompt", "consent")],
        }),
        _ => None,
    }
}

struct PendingAuth {
    verifier: String,
    instance_id: String,
    project_path: String,
    provider: String,
    redirect_uri: String,
    created_at: u64,
}

const PENDING_TTL_SECS: u64 = 15 * 60;

fn pending() -> &'static Mutex<HashMap<String, PendingAuth>> {
    static PENDING: std::sync::OnceLock<Mutex<HashMap<String, PendingAuth>>> =
        std::sync::OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn random_token() -> String {
    let mut bytes = Vec::with_capacity(48);
    for _ in 0..3 {
        bytes.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    }
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn pkce_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

fn url_encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn url_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                if let Ok(v) = u8::from_str_radix(&value[i + 1..i + 3], 16) {
                    out.push(v);
                    i += 3;
                    continue;
                }
                out.push(b'%');
            }
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn parse_query(query: &str) -> HashMap<String, String> {
    query
        .trim_start_matches('?')
        .split('&')
        .filter(|p| !p.is_empty())
        .filter_map(|pair| {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            Some((url_decode(k), url_decode(v)))
        })
        .collect()
}

/// Build the authorization URL for `instance` and remember the PKCE
/// verifier under a random `state` until the callback arrives.
pub fn start(
    ctx: &AppCtx,
    project_path: &str,
    instance_id: &str,
    redirect_uri: &str,
) -> Result<String, String> {
    let instance = store::get_instance(std::path::Path::new(project_path), instance_id)
        .ok_or_else(|| format!("Unknown connector instance: {instance_id}"))?;
    let descriptor = super::descriptors()
        .into_iter()
        .find(|d| d.kind == instance.kind)
        .ok_or_else(|| format!("Unknown connector kind: {}", instance.kind))?;
    let (provider_name, scopes) = match descriptor.auth {
        super::AuthKind::OAuth2 { provider, scopes } => (provider, scopes),
        super::AuthKind::None => return Err("This connector does not use OAuth".into()),
    };
    let def = provider(&provider_name).ok_or_else(|| format!("Unknown OAuth provider: {provider_name}"))?;
    let client_id = instance
        .config
        .get("clientId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Enter the OAuth client id first".to_string())?;
    let secrets = store::load_secrets(ctx, instance_id);
    if secrets.get_str("clientSecret").is_none() {
        return Err("Enter the OAuth client secret first".into());
    }

    let verifier = random_token();
    let state = random_token();
    let challenge = pkce_challenge(&verifier);
    {
        let mut map = pending().lock().unwrap_or_else(|p| p.into_inner());
        let now = now_secs();
        map.retain(|_, p| now.saturating_sub(p.created_at) < PENDING_TTL_SECS);
        map.insert(
            state.clone(),
            PendingAuth {
                verifier,
                instance_id: instance_id.to_string(),
                project_path: project_path.to_string(),
                provider: provider_name.clone(),
                redirect_uri: redirect_uri.to_string(),
                created_at: now,
            },
        );
    }

    let mut url = format!(
        "{}?response_type=code&client_id={}&redirect_uri={}&scope={}&state={}&code_challenge={}&code_challenge_method=S256",
        def.auth_url,
        url_encode(client_id),
        url_encode(redirect_uri),
        url_encode(&scopes.join(" ")),
        url_encode(&state),
        url_encode(&challenge),
    );
    for (k, v) in def.extra_auth_params {
        url.push('&');
        url.push_str(&url_encode(k));
        url.push('=');
        url.push_str(&url_encode(v));
    }
    Ok(url)
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    token_type: Option<String>,
}

async fn post_token(token_url: &str, form: &[(&str, &str)]) -> Result<TokenResponse, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .post(token_url)
        .form(form)
        .send()
        .await
        .map_err(|e| format!("token request failed: {e}"))?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("token endpoint returned {status}: {body}"));
    }
    serde_json::from_str::<TokenResponse>(&body).map_err(|e| format!("bad token response: {e}"))
}

fn store_tokens(ctx: &AppCtx, instance_id: &str, token: &TokenResponse) -> Result<Secrets, String> {
    let mut patch = Map::new();
    patch.insert("accessToken".into(), Value::String(token.access_token.clone()));
    if let Some(refresh) = &token.refresh_token {
        patch.insert("refreshToken".into(), Value::String(refresh.clone()));
    }
    let expires_at = now_secs() + token.expires_in.unwrap_or(3600);
    patch.insert("expiresAt".into(), json!(expires_at));
    if let Some(scope) = &token.scope {
        patch.insert("scope".into(), Value::String(scope.clone()));
    }
    if let Some(tt) = &token.token_type {
        patch.insert("tokenType".into(), Value::String(tt.clone()));
    }
    patch.insert("connectedAt".into(), json!(now_secs()));
    store::merge_secrets(ctx, instance_id, &patch)
}

/// Handle the provider redirect. Returns an HTML page for the browser in
/// both the success and the failure case.
pub async fn handle_callback(ctx: &AppCtx, query: &str) -> (bool, String) {
    let params = parse_query(query);
    if let Some(err) = params.get("error") {
        return (false, callback_page(false, &format!("The provider reported: {err}")));
    }
    let (Some(code), Some(state)) = (params.get("code"), params.get("state")) else {
        return (false, callback_page(false, "Missing code or state in the callback"));
    };
    let pending_auth = {
        let mut map = pending().lock().unwrap_or_else(|p| p.into_inner());
        map.remove(state)
    };
    let Some(pending_auth) = pending_auth else {
        return (false, callback_page(false, "Unknown or expired sign-in attempt. Start again from Settings → Connectors."));
    };
    let Some(def) = provider(&pending_auth.provider) else {
        return (false, callback_page(false, "Unknown OAuth provider"));
    };
    let instance = store::get_instance(
        std::path::Path::new(&pending_auth.project_path),
        &pending_auth.instance_id,
    );
    let Some(instance) = instance else {
        return (false, callback_page(false, "The connector was deleted while signing in"));
    };
    let client_id = instance
        .config
        .get("clientId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let secrets = store::load_secrets(ctx, &pending_auth.instance_id);
    let client_secret = secrets.get_str("clientSecret").unwrap_or("").to_string();

    let form = [
        ("grant_type", "authorization_code"),
        ("code", code.as_str()),
        ("client_id", client_id.as_str()),
        ("client_secret", client_secret.as_str()),
        ("redirect_uri", pending_auth.redirect_uri.as_str()),
        ("code_verifier", pending_auth.verifier.as_str()),
    ];
    match post_token(def.token_url, &form).await {
        Ok(token) => match store_tokens(ctx, &pending_auth.instance_id, &token) {
            Ok(_) => {
                let _ = ctx.emit(
                    "connectors://oauth",
                    json!({ "instanceId": pending_auth.instance_id, "status": "connected" }),
                );
                (true, callback_page(true, &format!("\"{}\" is connected. You can close this tab.", instance.name)))
            }
            Err(err) => (false, callback_page(false, &format!("Could not save tokens: {err}"))),
        },
        Err(err) => (false, callback_page(false, &err)),
    }
}

fn callback_page(ok: bool, message: &str) -> String {
    let title = if ok { "Connected" } else { "Sign-in failed" };
    let color = if ok { "#16a34a" } else { "#dc2626" };
    let escaped = message
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>LLM Wiki — {title}</title></head>\
<body style=\"font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#fafafa;color:#111\">\
<div style=\"max-width:420px;padding:32px;border-radius:12px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.1)\">\
<h1 style=\"font-size:18px;margin:0 0 8px;color:{color}\">{title}</h1><p style=\"margin:0;font-size:14px;line-height:1.5\">{escaped}</p></div></body></html>"
    )
}

/// A valid access token for `instance_id`, refreshing (and persisting) it
/// when it is within a minute of expiring.
pub async fn access_token(ctx: &AppCtx, instance_id: &str, provider_name: &str) -> Result<String, String> {
    let secrets = store::load_secrets(ctx, instance_id);
    let expires_at = secrets
        .0
        .get("expiresAt")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if let Some(token) = secrets.get_str("accessToken") {
        if expires_at > now_secs() + 60 {
            return Ok(token.to_string());
        }
    }
    let refresh = secrets
        .get_str("refreshToken")
        .ok_or_else(|| "Not connected. Use \"Connect\" in Settings → Connectors.".to_string())?
        .to_string();
    let def = provider(provider_name).ok_or_else(|| format!("Unknown OAuth provider: {provider_name}"))?;
    // The client id is mirrored into the secrets record when the instance
    // is saved (`remember_client_id`) so refreshes need no project access.
    let client_id = secrets
        .get_str("clientId")
        .map(str::to_string)
        .ok_or_else(|| "Client id missing from stored credentials; reconnect the connector".to_string())?;
    let client_secret = secrets.get_str("clientSecret").unwrap_or("").to_string();
    let form = [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh.as_str()),
        ("client_id", client_id.as_str()),
        ("client_secret", client_secret.as_str()),
    ];
    let token = post_token(def.token_url, &form).await?;
    store_tokens(ctx, instance_id, &token)?;
    Ok(token.access_token)
}

/// Copy the client id next to the tokens so refreshes work without the
/// project file (call whenever the instance is saved).
pub fn remember_client_id(ctx: &AppCtx, instance_id: &str, client_id: &str) -> Result<(), String> {
    if client_id.trim().is_empty() {
        return Ok(());
    }
    let mut patch = Map::new();
    patch.insert("clientId".into(), Value::String(client_id.trim().to_string()));
    store::merge_secrets(ctx, instance_id, &patch).map(|_| ())
}

/// Forget tokens (keeps the client secret so the user can reconnect).
pub fn disconnect(ctx: &AppCtx, instance_id: &str) -> Result<(), String> {
    let mut patch = Map::new();
    for key in ["accessToken", "refreshToken", "expiresAt", "scope", "tokenType", "connectedAt"] {
        patch.insert(key.into(), Value::Null);
    }
    store::merge_secrets(ctx, instance_id, &patch).map(|_| ())
}

/// Connection status for the UI (never exposes token values).
pub fn status(ctx: &AppCtx, instance_id: &str) -> Value {
    let secrets = store::load_secrets(ctx, instance_id);
    json!({
        "hasClientSecret": secrets.get_str("clientSecret").is_some(),
        "connected": secrets.get_str("refreshToken").is_some(),
        "connectedAt": secrets.0.get("connectedAt").cloned().unwrap_or(Value::Null),
        "scope": secrets.0.get("scope").cloned().unwrap_or(Value::Null),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_is_base64url_sha256() {
        // RFC 7636 appendix B example
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(pkce_challenge(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn query_parsing_decodes() {
        let q = parse_query("code=4%2Fabc&state=x+y&scope=https%3A%2F%2Fa");
        assert_eq!(q["code"], "4/abc");
        assert_eq!(q["state"], "x y");
        assert_eq!(q["scope"], "https://a");
    }

    #[test]
    fn start_requires_credentials() {
        let base = std::env::temp_dir().join(format!("llm-wiki-oauth-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let ctx = AppCtx::headless(base.join("data"), None);
        let mut config = Map::new();
        config.insert("clientId".into(), Value::String("id".into()));
        let instance = super::super::ConnectorInstance {
            id: "g".into(),
            kind: "google-drive".into(),
            name: "G".into(),
            enabled: true,
            interval_minutes: 0,
            config,
            max_file_size_mb: 0,
            created_at: 0,
            last_sync: None,
        };
        store::upsert_instance(&base, instance).unwrap();
        let err = start(&ctx, base.to_str().unwrap(), "g", "http://127.0.0.1/cb").unwrap_err();
        assert!(err.contains("client secret"));
        let mut patch = Map::new();
        patch.insert("clientSecret".into(), Value::String("s".into()));
        store::merge_secrets(&ctx, "g", &patch).unwrap();
        let url = start(&ctx, base.to_str().unwrap(), "g", "http://127.0.0.1/cb").unwrap();
        assert!(url.starts_with("https://accounts.google.com/o/oauth2/v2/auth?"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("drive.readonly"));
        let _ = std::fs::remove_dir_all(base);
    }
}
