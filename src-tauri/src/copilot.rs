//! Direct Copilot provider: credentials exist only in process memory. Sign in again
//! after every app restart. Text-only, buffered completions; no responses/vision.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const CLIENT_ID: &str = "Iv1.b507a08c87ecfe98";
const DEVICE_URL: &str = "https://github.com/login/device/code";
const POLL_URL: &str = "https://github.com/login/oauth/access_token";
const EXCHANGE_URL: &str = "https://api.github.com/copilot_internal/v2/token";
const DEFAULT_ORIGIN: &str = "https://api.githubcopilot.com";
const MAX_BODY: usize = 4 * 1024 * 1024;
type HttpFuture<'a> = Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>>;

// Internal wire requests only: IPC never accepts a URL, headers or credentials.
struct WireRequest {
    url: String,
    auth: Option<String>,
    form: Option<Vec<(&'static str, String)>>,
    body: Option<Value>,
}
trait Http: Send + Sync {
    fn send<'a>(&'a self, request: WireRequest) -> HttpFuture<'a>;
}
fn build_request(
    client: &reqwest::Client,
    request: WireRequest,
) -> Result<reqwest::RequestBuilder, String> {
    let mut builder = if request.form.is_some() || request.body.is_some() {
        client.post(&request.url)
    } else {
        client.get(&request.url)
    };
    builder = builder
        .header("Accept", "application/json")
        .header("User-Agent", "GitHubCopilotChat/0.26.7")
        .header("Editor-Version", "vscode/1.104.1")
        .header("Copilot-Integration-Id", "vscode-chat")
        .header("Openai-Intent", "conversation-edits")
        .header("x-initiator", "agent");
    if let Some(auth) = request.auth {
        let mut header = reqwest::header::HeaderValue::from_str(&auth)
            .map_err(|_| "Invalid Copilot authorization".to_string())?;
        header.set_sensitive(true);
        builder = builder.header(reqwest::header::AUTHORIZATION, header);
    }
    if let Some(form) = request.form {
        builder = builder.form(&form);
    }
    if let Some(body) = request.body {
        builder = builder.json(&body);
    }
    Ok(builder)
}
struct DirectHttp;
impl Http for DirectHttp {
    fn send<'a>(&'a self, request: WireRequest) -> HttpFuture<'a> {
        Box::pin(async move {
            // Never use proxy::configure_http_client: its invalid-cert option
            // must not weaken TLS for credential-bearing requests.
            let client = reqwest::Client::builder()
                .https_only(true)
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(180))
                .connect_timeout(Duration::from_secs(15))
                .build()
                .map_err(|_| "Copilot HTTP client unavailable".to_string())?;
            let builder = build_request(&client, request)?;
            let mut response = builder
                .send()
                .await
                .map_err(|_| "Copilot network request failed".to_string())?;
            if !response.status().is_success() {
                return Err(format!("Copilot HTTP {}", response.status().as_u16()));
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| "Copilot response read failed".to_string())?
            {
                if bytes.len().saturating_add(chunk.len()) > MAX_BODY {
                    return Err("Copilot response too large".into());
                }
                bytes.extend_from_slice(&chunk);
            }
            serde_json::from_slice(&bytes).map_err(|_| "Invalid Copilot JSON response".into())
        })
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStart {
    flow_id: String,
    user_code: String,
    verification_uri: String,
    interval: u64,
    expires_in: u64,
}
#[derive(Serialize)]
pub struct AuthPoll {
    authenticated: bool,
    pending: bool,
    interval: u64,
}
#[derive(Serialize)]
pub struct AuthStatus {
    authenticated: bool,
}
#[derive(Clone, Serialize)]
pub struct Model {
    pub id: String,
    pub name: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Completion {
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Message {
    role: String,
    content: String,
}
struct Flow {
    id: String,
    device: String,
    deadline: Instant,
    next_poll: Instant,
    interval: u64,
}
#[derive(Clone)]
struct ApiToken {
    token: String,
    expires_at: u64,
    origin: String,
}
#[derive(Default)]
struct State {
    generation: u64,
    flow: Option<Flow>,
    oauth: Option<String>,
    api: Option<ApiToken>,
}
struct Service {
    state: Mutex<State>,
    gate: tokio::sync::Mutex<()>,
    http: Arc<dyn Http>,
}
impl Service {
    fn new(http: Arc<dyn Http>) -> Self {
        Self {
            state: Mutex::new(State::default()),
            gate: tokio::sync::Mutex::new(()),
            http,
        }
    }
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, State>, String> {
        self.state
            .lock()
            .map_err(|_| "Copilot state unavailable".into())
    }
    fn check(&self, generation: u64) -> Result<(), String> {
        if self.lock()?.generation == generation {
            Ok(())
        } else {
            Err("Copilot session changed; retry after signing in".into())
        }
    }
    fn logout(&self) -> Result<(), String> {
        let mut state = self.lock()?;
        let generation = state.generation.wrapping_add(1);
        *state = State {
            generation,
            ..State::default()
        };
        Ok(())
    }
    fn status(&self) -> Result<AuthStatus, String> {
        Ok(AuthStatus {
            authenticated: self.lock()?.oauth.is_some(),
        })
    }
    async fn start(&self) -> Result<AuthStart, String> {
        let expected_generation = self.lock()?.generation;
        let _gate = self.gate.lock().await;
        let generation = {
            let mut state = self.lock()?;
            if state.generation != expected_generation {
                return Err("Copilot sign-in cancelled".into());
            }
            let generation = state.generation.wrapping_add(1);
            *state = State {
                generation,
                ..State::default()
            };
            generation
        };
        let data = self
            .http
            .send(WireRequest {
                url: DEVICE_URL.into(),
                auth: None,
                form: Some(vec![
                    ("client_id", CLIENT_ID.into()),
                    ("scope", "read:user".into()),
                ]),
                body: None,
            })
            .await?;
        let device = required_text(&data, "device_code")?;
        let user_code = required_text(&data, "user_code")?;
        if data.get("verification_uri").and_then(Value::as_str)
            != Some("https://github.com/login/device")
        {
            return Err("Unexpected GitHub verification URI".into());
        }
        let interval = data.get("interval").and_then(Value::as_u64).unwrap_or(5);
        if !(1..=3600).contains(&interval) {
            return Err("Invalid device poll interval".into());
        }
        let expires_in = data
            .get("expires_in")
            .and_then(Value::as_u64)
            .filter(|n| *n > 0 && *n <= 3600)
            .ok_or("Invalid device expiry")?;
        let flow_id = uuid::Uuid::new_v4().to_string();
        let mut state = self.lock()?;
        if state.generation != generation {
            return Err("Copilot sign-in cancelled".into());
        }
        state.flow = Some(Flow {
            id: flow_id.clone(),
            device,
            deadline: Instant::now() + Duration::from_secs(expires_in),
            next_poll: Instant::now() + Duration::from_secs(interval),
            interval,
        });
        Ok(AuthStart {
            flow_id,
            user_code,
            verification_uri: "https://github.com/login/device".into(),
            interval,
            expires_in,
        })
    }
    async fn poll(&self, id: &str) -> Result<AuthPoll, String> {
        let _gate = self.gate.lock().await;
        let (generation, device, interval, deadline) = {
            let mut state = self.lock()?;
            let generation = state.generation;
            let flow = state
                .flow
                .as_mut()
                .filter(|flow| flow.id == id)
                .ok_or("Unknown Copilot sign-in flow")?;
            if Instant::now() >= flow.deadline {
                state.flow = None;
                return Err("Copilot device code expired".into());
            }
            if Instant::now() < flow.next_poll {
                return Ok(AuthPoll {
                    authenticated: false,
                    pending: true,
                    interval: flow.interval,
                });
            }
            flow.next_poll = Instant::now() + Duration::from_secs(flow.interval);
            (
                generation,
                flow.device.clone(),
                flow.interval,
                flow.deadline,
            )
        };
        let data = self
            .http
            .send(WireRequest {
                url: POLL_URL.into(),
                auth: None,
                form: Some(vec![
                    ("client_id", CLIENT_ID.into()),
                    ("device_code", device),
                    (
                        "grant_type",
                        "urn:ietf:params:oauth:grant-type:device_code".into(),
                    ),
                ]),
                body: None,
            })
            .await?;
        self.check(generation)?;
        if Instant::now() >= deadline {
            let mut state = self.lock()?;
            if state.generation == generation {
                state.flow = None;
            }
            return Err("Copilot device code expired".into());
        }
        if let Some(error) = data.get("error").and_then(Value::as_str) {
            let mut state = self.lock()?;
            if state.generation != generation {
                return Err("Copilot sign-in cancelled".into());
            }
            if error == "authorization_pending" || error == "slow_down" {
                let flow = state.flow.as_mut().ok_or("Copilot sign-in cancelled")?;
                if error == "slow_down" {
                    let next_interval = interval
                        .saturating_add(5)
                        .max(data.get("interval").and_then(Value::as_u64).unwrap_or(0));
                    if next_interval > 3600 {
                        state.flow = None;
                        return Err("Invalid device poll interval".into());
                    }
                    flow.interval = next_interval;
                }
                flow.next_poll = Instant::now() + Duration::from_secs(flow.interval);
                return Ok(AuthPoll {
                    authenticated: false,
                    pending: true,
                    interval: flow.interval,
                });
            }
            state.flow = None;
            return Err(match error {
                "expired_token" => "Copilot device code expired",
                "access_denied" => "Copilot authorization denied",
                _ => "Copilot authorization failed",
            }
            .into());
        }
        let oauth = required_text(&data, "access_token")?;
        let api = self.exchange(&oauth).await?;
        let mut state = self.lock()?;
        if state.generation != generation {
            return Err("Copilot sign-in cancelled".into());
        }
        if Instant::now() >= deadline {
            state.flow = None;
            return Err("Copilot device code expired".into());
        }
        state.oauth = Some(oauth);
        state.api = Some(api);
        state.flow = None;
        Ok(AuthPoll {
            authenticated: true,
            pending: false,
            interval,
        })
    }
    async fn exchange(&self, oauth: &str) -> Result<ApiToken, String> {
        parse_token(
            self.http
                .send(WireRequest {
                    url: EXCHANGE_URL.into(),
                    auth: Some(format!("token {oauth}")),
                    form: None,
                    body: None,
                })
                .await?,
        )
    }
    async fn token(&self) -> Result<(u64, ApiToken), String> {
        // Singleflight refresh: recheck cache under the async gate. Logout never
        // waits for I/O, and the generation check rejects stale publications.
        let _gate = self.gate.lock().await;
        let (generation, oauth) = {
            let state = self.lock()?;
            let oauth = state
                .oauth
                .clone()
                .ok_or("Sign in to GitHub Copilot first")?;
            if let Some(api) = &state.api {
                if fresh(api.expires_at, epoch()) {
                    return Ok((state.generation, api.clone()));
                }
            }
            (state.generation, oauth)
        };
        let api = self.exchange(&oauth).await?;
        let mut state = self.lock()?;
        if state.generation != generation {
            return Err("Copilot session changed".into());
        }
        state.api = Some(api.clone());
        Ok((generation, api))
    }
    async fn catalog(&self, generation: u64, api: &ApiToken) -> Result<Vec<Model>, String> {
        self.check(generation)?;
        let data = self
            .http
            .send(WireRequest {
                url: format!("{}/models", api.origin),
                auth: Some(format!("Bearer {}", api.token)),
                form: None,
                body: None,
            })
            .await?;
        self.check(generation)?;
        parse_models(data)
    }
    async fn models(&self) -> Result<Vec<Model>, String> {
        let (generation, api) = self.token().await?;
        self.catalog(generation, &api).await
    }
    async fn complete(
        &self,
        model: &str,
        messages: Vec<Value>,
        max_tokens: Option<u32>,
    ) -> Result<Completion, String> {
        let messages = validate_messages(messages)?;
        let max_tokens = max_tokens.unwrap_or(2048);
        if !(1..=32768).contains(&max_tokens) {
            return Err("Copilot maxTokens must be between 1 and 32768".into());
        }
        for attempt in 0..2 {
            let (generation, api) = self.token().await?;
            let models = self.catalog(generation, &api).await?;
            let model = if model.is_empty() {
                models
                    .iter()
                    .find(|m| m.id == "gpt-4.1-mini")
                    .or_else(|| models.iter().find(|m| m.id == "gpt-4.1"))
                    .ok_or("Select an eligible Copilot chat model")?
            } else {
                models
                    .iter()
                    .find(|m| m.id == model)
                    .ok_or("Unsupported Copilot chat model")?
            };
            self.check(generation)?;
            let result = self.http.send(WireRequest { url: format!("{}/chat/completions", api.origin), auth: Some(format!("Bearer {}", api.token)), form: None, body: Some(json!({"model":model.id,"messages":messages,"max_tokens":max_tokens,"stream":false})) }).await;
            self.check(generation)?;
            match result {
                // Buffered requests emitted no output, so one stale-token retry
                // is safe. Never replay 403/429 or retry after a second 401.
                Err(error) if attempt == 0 && error == "Copilot HTTP 401" => {
                    let mut state = self.lock()?;
                    if state.generation != generation {
                        return Err("Copilot session changed".into());
                    }
                    if state
                        .api
                        .as_ref()
                        .is_some_and(|cached| cached.token == api.token)
                    {
                        state.api = None;
                    }
                }
                Err(error) => return Err(error),
                Ok(data) => return parse_completion(data),
            }
        }
        Err("Copilot authorization rejected".into())
    }
}
fn epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn fresh(expires_at: u64, now: u64) -> bool {
    expires_at > now.saturating_add(120)
}
fn required_text(data: &Value, key: &str) -> Result<String, String> {
    data.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 16384 && !s.chars().any(char::is_control))
        .map(str::to_owned)
        .ok_or_else(|| "Invalid Copilot protocol response".into())
}
fn validate_origin(origin: &str) -> Result<String, String> {
    // URL parsers normalize dot segments, backslashes and whitespace. Reject
    // those in the original wire value rather than validating a repaired URL.
    let authority = origin
        .strip_prefix("https://")
        .ok_or("Invalid Copilot API origin")?;
    if authority.contains('@')
        || authority.contains('\\')
        || authority.chars().any(char::is_whitespace)
        || authority
            .split_once('/')
            .is_some_and(|(_, path)| !path.is_empty())
    {
        return Err("Untrusted Copilot API origin".into());
    }
    let url = reqwest::Url::parse(origin).map_err(|_| "Invalid Copilot API origin")?;
    if url.scheme() != "https"
        || !matches!(
            url.host_str(),
            Some(
                "api.githubcopilot.com"
                    | "api.business.githubcopilot.com"
                    | "api.enterprise.githubcopilot.com"
            )
        )
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("Untrusted Copilot API origin".into());
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}
fn parse_token(data: Value) -> Result<ApiToken, String> {
    let token = required_text(&data, "token")?;
    let expires_at = data
        .get("expires_at")
        .and_then(Value::as_u64)
        .filter(|n| fresh(*n, epoch()))
        .ok_or("Invalid Copilot token expiry")?;
    let origin = if let Some(endpoint) = data.pointer("/endpoints/api") {
        validate_origin(endpoint.as_str().ok_or("Invalid Copilot API origin")?)?
    } else if let Some(proxy) = token
        .split(';')
        .find_map(|part| part.trim().strip_prefix("proxy-ep="))
    {
        let host = proxy.strip_prefix("https://").unwrap_or(proxy);
        let host = host
            .strip_prefix("proxy.")
            .ok_or("Invalid Copilot proxy endpoint")?;
        validate_origin(&format!("https://api.{host}"))?
    } else {
        DEFAULT_ORIGIN.into()
    };
    Ok(ApiToken {
        token,
        expires_at,
        origin,
    })
}
fn validate_messages(messages: Vec<Value>) -> Result<Vec<Message>, String> {
    if messages.is_empty() || messages.len() > 128 {
        return Err("Copilot requires 1 to 128 text messages".into());
    }
    let mut total = 0usize;
    messages
        .into_iter()
        .map(|value| {
            let message: Message = serde_json::from_value(value)
                .map_err(|_| "Copilot accepts only role and text content")?;
            if !matches!(message.role.as_str(), "system" | "user" | "assistant") {
                return Err("Unsupported Copilot message role".into());
            }
            total = total.saturating_add(message.content.len());
            if total > 1024 * 1024 {
                return Err("Copilot messages too large".into());
            }
            Ok(message)
        })
        .collect()
}
fn parse_models(data: Value) -> Result<Vec<Model>, String> {
    let entries = data
        .get("data")
        .and_then(Value::as_array)
        .ok_or("Invalid Copilot model catalog")?;
    let mut models = Vec::new();
    for entry in entries {
        if !entry
            .get("supported_endpoints")
            .and_then(Value::as_array)
            .is_some_and(|endpoints| {
                endpoints
                    .iter()
                    .any(|v| v.as_str() == Some("/chat/completions"))
            })
        {
            continue;
        }
        let Ok(id) = required_text(entry, "id") else {
            continue;
        };
        if models.iter().any(|m: &Model| m.id == id) {
            continue;
        }
        let name = entry
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(&id)
            .to_string();
        models.push(Model { id, name });
    }
    Ok(models)
}
fn parse_completion(data: Value) -> Result<Completion, String> {
    let choice = data
        .pointer("/choices/0")
        .ok_or("Copilot response missing assistant text")?;
    let content = choice
        .pointer("/message/content")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or("Copilot response missing assistant text")?
        .to_string();
    Ok(Completion {
        content,
        finish_reason: choice
            .get("finish_reason")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}
fn service() -> &'static Service {
    static SERVICE: OnceLock<Service> = OnceLock::new();
    SERVICE.get_or_init(|| Service::new(Arc::new(DirectHttp)))
}
#[tauri::command]
pub async fn copilot_auth_start() -> Result<AuthStart, String> {
    service().start().await
}
#[tauri::command]
pub async fn copilot_auth_poll(flow_id: String) -> Result<AuthPoll, String> {
    service().poll(&flow_id).await
}
#[tauri::command]
pub fn copilot_auth_status() -> Result<AuthStatus, String> {
    service().status()
}
#[tauri::command]
pub fn copilot_logout() -> Result<(), String> {
    service().logout()
}
#[tauri::command]
pub async fn copilot_models() -> Result<Vec<Model>, String> {
    service().models().await
}
#[tauri::command]
pub async fn copilot_complete(
    model: String,
    messages: Vec<Value>,
    max_tokens: Option<u32>,
) -> Result<Completion, String> {
    service().complete(&model, messages, max_tokens).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    #[test]
    fn http_headers_and_body_are_constructed_without_network() {
        let client = reqwest::Client::new();
        let request = build_request(
            &client,
            WireRequest {
                url: EXCHANGE_URL.into(),
                auth: Some("token mock-oauth".into()),
                form: None,
                body: None,
            },
        )
        .unwrap()
        .build()
        .unwrap();
        assert_eq!(request.method(), reqwest::Method::GET);
        assert_eq!(request.headers()["Editor-Version"], "vscode/1.104.1");
        assert_eq!(request.headers()["Copilot-Integration-Id"], "vscode-chat");
        assert_eq!(request.headers()["Openai-Intent"], "conversation-edits");
        assert_eq!(request.headers()["x-initiator"], "agent");
        assert!(request.headers()["authorization"].is_sensitive());
        let request = build_request(
            &client,
            WireRequest {
                url: DEVICE_URL.into(),
                auth: None,
                form: Some(vec![("client_id", CLIENT_ID.into())]),
                body: None,
            },
        )
        .unwrap()
        .build()
        .unwrap();
        assert!(request.headers().get("authorization").is_none());
        assert_eq!(request.method(), reqwest::Method::POST);
        assert_eq!(
            request.headers()["content-type"],
            "application/x-www-form-urlencoded"
        );
    }
    struct MockHttp(std::sync::Mutex<VecDeque<Value>>);
    impl Http for MockHttp {
        fn send<'a>(&'a self, request: WireRequest) -> HttpFuture<'a> {
            Box::pin(async move {
                assert!(request.url.starts_with("https://"));
                match request.url.as_str() {
                    DEVICE_URL | POLL_URL => {
                        assert!(request.auth.is_none());
                        let form = request.form.as_ref().unwrap();
                        assert!(form
                            .iter()
                            .any(|(k, v)| *k == "client_id" && v == CLIENT_ID));
                        assert!(request.body.is_none());
                    }
                    EXCHANGE_URL => {
                        assert_eq!(request.auth.as_deref(), Some("token mock-oauth"))
                    }
                    "https://api.githubcopilot.com/models" => {
                        assert_eq!(request.auth.as_deref(), Some("Bearer mock-api"))
                    }
                    "https://api.githubcopilot.com/chat/completions" => {
                        assert_eq!(request.auth.as_deref(), Some("Bearer mock-api"));
                        let body = request.body.as_ref().unwrap();
                        assert_eq!(body["stream"], false);
                        assert_eq!(body["model"], "gpt-4.1-mini");
                        assert_eq!(body["max_tokens"], 2048);
                    }
                    _ => panic!("Unexpected mock endpoint"),
                }
                let reply = self
                    .0
                    .lock()
                    .unwrap()
                    .pop_front()
                    .ok_or_else(|| "Unexpected mock request".to_string())?;
                if let Some(error) = reply.get("mock_error").and_then(Value::as_str) {
                    return Err(error.to_string());
                }
                Ok(reply)
            })
        }
    }
    fn mock(values: Vec<Value>) -> Service {
        Service::new(std::sync::Arc::new(MockHttp(std::sync::Mutex::new(
            values.into(),
        ))))
    }
    fn device() -> Value {
        json!({"device_code":"mock-device", "user_code":"example-pairing-label", "verification_uri":"https://github.com/login/device", "interval":1, "expires_in":900})
    }
    fn exchange() -> Value {
        json!({"token":"mock-api", "expires_at":epoch()+1800, "endpoints":{"api":"https://api.githubcopilot.com"}})
    }
    fn catalog() -> Value {
        json!({"data":[{"id":"gpt-4.1-mini","name":"Mini","supported_endpoints":["/chat/completions"]}, {"id":"responses-only","supported_endpoints":["/responses"]}, {"id":"unknown"}]})
    }
    struct BlockingHttp {
        entered: tokio::sync::Notify,
        release: tokio::sync::Notify,
        calls: std::sync::atomic::AtomicUsize,
    }
    impl Http for BlockingHttp {
        fn send<'a>(&'a self, request: WireRequest) -> HttpFuture<'a> {
            Box::pin(async move {
                assert_eq!(request.url, EXCHANGE_URL);
                self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                self.entered.notify_one();
                self.release.notified().await;
                Ok(exchange())
            })
        }
    }
    fn blocking() -> Arc<BlockingHttp> {
        Arc::new(BlockingHttp {
            entered: tokio::sync::Notify::new(),
            release: tokio::sync::Notify::new(),
            calls: std::sync::atomic::AtomicUsize::new(0),
        })
    }
    #[tokio::test]
    async fn logout_during_refresh_cannot_restore_credentials() {
        let http = blocking();
        let service = Service::new(http.clone());
        service.lock().unwrap().oauth = Some("mock-oauth".into());
        let refresh = async { service.token().await };
        let logout = async {
            http.entered.notified().await;
            service.logout().unwrap();
            http.release.notify_one();
        };
        let (result, _) = tokio::join!(refresh, logout);
        assert!(result.is_err());
        assert!(!service.status().unwrap().authenticated);
        assert!(service.lock().unwrap().api.is_none());
    }
    #[tokio::test]
    async fn concurrent_refresh_is_singleflight() {
        let http = blocking();
        let service = Service::new(http.clone());
        service.lock().unwrap().oauth = Some("mock-oauth".into());
        let release = async {
            http.entered.notified().await;
            http.release.notify_one();
        };
        let (a, b, _) = tokio::join!(service.token(), service.token(), release);
        assert!(a.is_ok() && b.is_ok());
        assert_eq!(http.calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn expired_flow_does_not_poll_server() {
        let service = mock(vec![device()]);
        let flow = service.start().await.unwrap();
        service.lock().unwrap().flow.as_mut().unwrap().deadline = Instant::now();
        assert!(service
            .poll(&flow.flow_id)
            .await
            .err()
            .unwrap()
            .contains("expired"));
        assert!(service.lock().unwrap().flow.is_none());
    }
    #[tokio::test]
    async fn terminal_oauth_errors_are_sanitized_and_clear_flow() {
        for error in ["access_denied", "expired_token", "mock-private-error"] {
            let service = mock(vec![
                device(),
                json!({"error":error,"error_description":"mock-sensitive"}),
            ]);
            let flow = service.start().await.unwrap();
            service.lock().unwrap().flow.as_mut().unwrap().next_poll = Instant::now();
            let error = service.poll(&flow.flow_id).await.err().unwrap();
            assert!(!error.contains("mock-sensitive"));
            assert!(!error.contains("mock-private-error"));
            assert!(service.lock().unwrap().flow.is_none());
        }
    }
    #[test]
    fn token_origin_and_expiry_fail_closed() {
        let mut value = exchange();
        value["endpoints"]["api"] = json!("https://evil.test");
        assert!(parse_token(value).is_err());
        assert!(parse_token(json!({"token":"mock","expires_at":epoch()})).is_err());
        let parsed = parse_token(json!({"token":"mock;proxy-ep=proxy.business.githubcopilot.com","expires_at":epoch()+1800})).unwrap();
        assert_eq!(parsed.origin, "https://api.business.githubcopilot.com");
    }
    #[test]
    fn origin_policy_rejects_untrusted_and_ambiguous_urls() {
        for url in [
            "https://@api.githubcopilot.com",
            "https://api.githubcopilot.com/.",
            "https://api.githubcopilot.com/foo/..",
            "https://api.githubcopilot.com/%2e",
            "https://api.githubcopilot.com\\",
            "https://api.githubcopilot.com\n",
        ] {
            assert!(validate_origin(url).is_err(), "{url}");
        }
        for url in [
            "http://api.githubcopilot.com",
            "https://api.githubcopilot.com.evil.test",
            "https://evil.test",
            "https://u:p@api.githubcopilot.com",
            "https://api.githubcopilot.com:444",
            "https://api.githubcopilot.com/path",
            "https://api.githubcopilot.com?q=x",
            "https://api.githubcopilot.com#x",
        ] {
            assert!(validate_origin(url).is_err(), "{url}");
        }
        for url in [
            "https://api.githubcopilot.com",
            "https://api.business.githubcopilot.com/",
            "https://api.enterprise.githubcopilot.com:443",
        ] {
            assert!(validate_origin(url).is_ok());
        }
    }
    #[test]
    fn catalog_requires_explicit_chat_completions_support() {
        let models = parse_models(catalog()).unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "gpt-4.1-mini");
    }
    #[test]
    fn messages_are_text_only_and_strict() {
        assert!(validate_messages(vec![json!({"role":"user","content":"hello"})]).is_ok());
        for message in [
            json!({"role":"tool","content":"x"}),
            json!({"role":"user","content":[]}),
            json!({"role":"user","content":"x","url":"https://evil.test"}),
        ] {
            assert!(validate_messages(vec![message]).is_err());
        }
        assert!(validate_messages(vec![]).is_err());
    }
    #[test]
    fn refresh_boundary_is_120_seconds() {
        assert!(!fresh(1120, 1000));
        assert!(fresh(1121, 1000));
    }
    #[test]
    fn completion_parser_rejects_missing_text_without_leaking_body() {
        let result = parse_completion(json!({"secret":"mock-sensitive","choices":[]}));
        assert!(!result.err().unwrap().contains("mock-sensitive"));
        assert_eq!(
            parse_completion(
                json!({"choices":[{"message":{"content":"hello"},"finish_reason":"stop"}]})
            )
            .unwrap()
            .content,
            "hello"
        );
    }
    #[tokio::test]
    async fn device_flow_stays_backend_only_and_logout_clears_it() {
        let service = mock(vec![device()]);
        let flow = service.start().await.unwrap();
        let serialized = serde_json::to_string(&flow).unwrap();
        assert!(!serialized.contains("mock-device"));
        service.logout().unwrap();
        assert!(!service.status().unwrap().authenticated);
        assert!(service.poll(&flow.flow_id).await.is_err());
    }
    #[tokio::test]
    async fn polling_is_rate_limited_and_slow_down_is_monotonic() {
        let service = mock(vec![device(), json!({"error":"slow_down","interval":2})]);
        let flow = service.start().await.unwrap();
        assert!(service.poll(&flow.flow_id).await.unwrap().pending);
        service
            .state
            .lock()
            .unwrap()
            .flow
            .as_mut()
            .unwrap()
            .next_poll = Instant::now();
        assert_eq!(service.poll(&flow.flow_id).await.unwrap().interval, 6);
    }
    #[tokio::test]
    async fn mock_login_and_completion_use_eligible_model() {
        let service = mock(vec![
            device(),
            json!({"access_token":"mock-oauth"}),
            exchange(),
            catalog(),
            json!({"choices":[{"message":{"content":"mock answer"},"finish_reason":"stop"}]}),
        ]);
        let flow = service.start().await.unwrap();
        service
            .state
            .lock()
            .unwrap()
            .flow
            .as_mut()
            .unwrap()
            .next_poll = Instant::now();
        assert!(service.poll(&flow.flow_id).await.unwrap().authenticated);
        assert_eq!(
            service
                .complete(
                    "",
                    vec![json!({"role":"user","content":"mock prompt"})],
                    None
                )
                .await
                .unwrap()
                .content,
            "mock answer"
        );
    }
    #[tokio::test]
    async fn unauthorized_completion_refreshes_once_but_forbidden_does_not_retry() {
        let service = mock(vec![
            catalog(),
            json!({"mock_error":"Copilot HTTP 401"}),
            exchange(),
            catalog(),
            json!({"choices":[{"message":{"content":"retried answer"},"finish_reason":"stop"}]}),
        ]);
        service.lock().unwrap().oauth = Some("mock-oauth".into());
        service.lock().unwrap().api = Some(parse_token(exchange()).unwrap());
        assert_eq!(
            service
                .complete(
                    "gpt-4.1-mini",
                    vec![json!({"role":"user","content":"x"})],
                    None
                )
                .await
                .unwrap()
                .content,
            "retried answer"
        );
        for status in [403, 429] {
            let service = mock(vec![
                catalog(),
                json!({"mock_error":format!("Copilot HTTP {status}")}),
            ]);
            service.lock().unwrap().oauth = Some("mock-oauth".into());
            service.lock().unwrap().api = Some(parse_token(exchange()).unwrap());
            assert_eq!(
                service
                    .complete(
                        "gpt-4.1-mini",
                        vec![json!({"role":"user","content":"x"})],
                        None
                    )
                    .await
                    .err()
                    .unwrap(),
                format!("Copilot HTTP {status}")
            );
        }
    }
    #[tokio::test]
    async fn second_unauthorized_completion_is_not_replayed() {
        let service = mock(vec![
            catalog(),
            json!({"mock_error":"Copilot HTTP 401"}),
            exchange(),
            catalog(),
            json!({"mock_error":"Copilot HTTP 401"}),
        ]);
        service.lock().unwrap().oauth = Some("mock-oauth".into());
        service.lock().unwrap().api = Some(parse_token(exchange()).unwrap());
        assert_eq!(
            service
                .complete(
                    "gpt-4.1-mini",
                    vec![json!({"role":"user","content":"x"})],
                    None
                )
                .await
                .err()
                .unwrap(),
            "Copilot HTTP 401"
        );
    }
    #[tokio::test]
    async fn unsupported_model_and_invalid_limits_fail_closed() {
        let service = mock(vec![catalog()]);
        service.state.lock().unwrap().oauth = Some("mock-oauth".into());
        service.state.lock().unwrap().api = Some(parse_token(exchange()).unwrap());
        assert!(service
            .complete(
                "responses-only",
                vec![json!({"role":"user","content":"x"})],
                None
            )
            .await
            .is_err());
        assert!(service
            .complete("", vec![json!({"role":"user","content":"x"})], Some(0))
            .await
            .is_err());
    }
}
