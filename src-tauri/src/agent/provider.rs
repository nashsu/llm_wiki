use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use futures::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::Deserialize;
use serde_json::{json, Value};

use super::types::AgentImage;

const REQUEST_TIMEOUT_SECS: u64 = 180;
const DEFAULT_MAX_TOKENS: u32 = 2048;
const ANTHROPIC_VERSION: &str = "2023-06-01";
const AZURE_OPENAI_API_VERSION: &str = "2024-10-21";

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LlmReasoningConfig {
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub budget_tokens: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LlmConfig {
    pub provider: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub ollama_url: String,
    #[serde(default)]
    pub custom_endpoint: String,
    #[serde(default)]
    pub azure_api_version: Option<String>,
    #[serde(default)]
    pub api_mode: Option<String>,
    #[serde(default)]
    pub reasoning: Option<LlmReasoningConfig>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    // Mirrors the app's existing `maxContextSize` setting. It is treated as a
    // character budget here for compatibility with the TypeScript budget model;
    // do not reinterpret it as provider tokens without migrating callers.
    #[serde(default)]
    pub max_context_size: Option<usize>,
}

impl LlmConfig {
    pub fn is_usable_for_backend_http(&self) -> bool {
        let provider = self.provider.as_str();
        let has_model = !self.model.trim().is_empty();
        match provider {
            "openai" | "anthropic" | "google" | "azure" | "minimax" => {
                has_model && !self.api_key.trim().is_empty()
            }
            "ollama" => has_model && !self.ollama_url.trim().is_empty(),
            "custom" => has_model && !self.custom_endpoint.trim().is_empty(),
            // CLI transports need subprocess/session wiring and are handled in
            // a later Agent transport layer, not by this HTTP provider.
            "claude-code" | "codex-cli" => false,
            _ => false,
        }
    }
}

#[derive(Debug, Clone)]
pub struct LlmClient {
    config: LlmConfig,
    client: reqwest::Client,
}

pub trait AgentLlmProvider: Send + Sync {
    fn provider_name(&self) -> &str;
    fn model_name(&self) -> &str;
    fn generate_text<'a>(
        &'a self,
        system: &'a str,
        user: &'a str,
        images: &'a [AgentImage],
    ) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send + 'a>>;
    fn generate_text_stream<'a>(
        &'a self,
        system: &'a str,
        user: &'a str,
        images: &'a [AgentImage],
        on_delta: Box<dyn FnMut(&str) + Send + 'a>,
    ) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send + 'a>>;
}

impl AgentLlmProvider for LlmClient {
    fn provider_name(&self) -> &str {
        &self.config.provider
    }

    fn model_name(&self) -> &str {
        &self.config.model
    }

    fn generate_text<'a>(
        &'a self,
        system: &'a str,
        user: &'a str,
        images: &'a [AgentImage],
    ) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send + 'a>> {
        Box::pin(async move { LlmClient::generate_text(self, system, user, images).await })
    }

    fn generate_text_stream<'a>(
        &'a self,
        system: &'a str,
        user: &'a str,
        images: &'a [AgentImage],
        mut on_delta: Box<dyn FnMut(&str) + Send + 'a>,
    ) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send + 'a>> {
        Box::pin(async move {
            LlmClient::generate_text_stream(self, system, user, images, move |delta| {
                on_delta(delta)
            })
            .await
        })
    }
}

impl LlmClient {
    pub fn new(config: LlmConfig) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .build()
            .map_err(|err| format!("Failed to build LLM HTTP client: {err}"))?;
        Ok(Self { config, client })
    }

    pub async fn generate_text(
        &self,
        system: &str,
        user: &str,
        images: &[AgentImage],
    ) -> Result<String, String> {
        match self.config.provider.as_str() {
            "openai" => {
                self.generate_openai_like(
                    "https://api.openai.com/v1/chat/completions",
                    system,
                    user,
                    images,
                    true,
                )
                .await
            }
            "azure" => {
                let url = build_azure_url(&self.config)?;
                self.generate_openai_like(&url, system, user, images, false)
                    .await
            }
            "ollama" => {
                let url = build_ollama_url(&self.config.ollama_url);
                self.generate_openai_like(&url, system, user, images, true)
                    .await
            }
            "custom" if self.config.api_mode.as_deref() == Some("anthropic_messages") => {
                let url = build_anthropic_url(&self.config.custom_endpoint);
                self.generate_anthropic_like(&url, system, user, images)
                    .await
            }
            "custom" => {
                let url = build_custom_openai_url(&self.config);
                self.generate_openai_like(&url, system, user, images, !is_azure_endpoint(&url))
                    .await
            }
            "anthropic" => {
                self.generate_anthropic_like(
                    "https://api.anthropic.com/v1/messages",
                    system,
                    user,
                    images,
                )
                .await
            }
            "minimax" => {
                if !images.is_empty() {
                    return Err("MiniMax official Anthropic-compatible endpoint does not support image input. Use a vision-capable provider for image chat.".to_string());
                }
                let base = if self.config.custom_endpoint.trim().is_empty() {
                    "https://api.minimax.io/anthropic"
                } else {
                    self.config.custom_endpoint.trim()
                };
                let url = build_anthropic_url(base);
                self.generate_anthropic_like(&url, system, user, images)
                    .await
            }
            "google" => self.generate_google(system, user, images).await,
            other => Err(format!(
                "Provider '{other}' is not supported by the backend HTTP Agent yet"
            )),
        }
    }

    pub async fn generate_text_stream<F>(
        &self,
        system: &str,
        user: &str,
        images: &[AgentImage],
        on_delta: F,
    ) -> Result<String, String>
    where
        F: FnMut(&str) + Send,
    {
        match self.config.provider.as_str() {
            "openai" => {
                self.stream_openai_like(
                    "https://api.openai.com/v1/chat/completions",
                    system,
                    user,
                    images,
                    true,
                    on_delta,
                )
                .await
            }
            "azure" => {
                let url = build_azure_url(&self.config)?;
                self.stream_openai_like(&url, system, user, images, false, on_delta)
                    .await
            }
            "ollama" => {
                let url = build_ollama_url(&self.config.ollama_url);
                self.stream_openai_like(&url, system, user, images, true, on_delta)
                    .await
            }
            "custom" if self.config.api_mode.as_deref() == Some("anthropic_messages") => {
                let url = build_anthropic_url(&self.config.custom_endpoint);
                self.stream_anthropic_like(&url, system, user, images, on_delta)
                    .await
            }
            "custom" => {
                let url = build_custom_openai_url(&self.config);
                self.stream_openai_like(
                    &url,
                    system,
                    user,
                    images,
                    !is_azure_endpoint(&url),
                    on_delta,
                )
                .await
            }
            "anthropic" => {
                self.stream_anthropic_like(
                    "https://api.anthropic.com/v1/messages",
                    system,
                    user,
                    images,
                    on_delta,
                )
                .await
            }
            "minimax" => {
                if !images.is_empty() {
                    return Err("MiniMax official Anthropic-compatible endpoint does not support image input. Use a vision-capable provider for image chat.".to_string());
                }
                let base = if self.config.custom_endpoint.trim().is_empty() {
                    "https://api.minimax.io/anthropic"
                } else {
                    self.config.custom_endpoint.trim()
                };
                let url = build_anthropic_url(base);
                self.stream_anthropic_like(&url, system, user, images, on_delta)
                    .await
            }
            "google" => self.stream_google(system, user, images, on_delta).await,
            _ => self.generate_text(system, user, images).await,
        }
    }

    fn openai_like_body(
        &self,
        system: &str,
        user: &str,
        images: &[AgentImage],
        include_model: bool,
        stream: bool,
    ) -> Value {
        let user_content = openai_user_content(user, images);
        let mut body = json!({
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": user_content }
            ],
            "stream": stream,
            "max_tokens": self.max_output_tokens()
        });
        if include_model {
            body["model"] = Value::String(self.config.model.clone());
        }
        apply_openai_reasoning(&mut body, self.config.reasoning.as_ref());
        body
    }

    async fn generate_openai_like(
        &self,
        url: &str,
        system: &str,
        user: &str,
        images: &[AgentImage],
        include_model: bool,
    ) -> Result<String, String> {
        let body = self.openai_like_body(system, user, images, include_model, false);

        let response = self
            .client
            .post(url)
            .headers(openai_headers(&self.config, url)?)
            .json(&body)
            .send()
            .await
            .map_err(|err| format!("LLM request failed: {err}"))?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|err| format!("Failed to read LLM response: {err}"))?;
        if !status.is_success() {
            return Err(format!("LLM HTTP {status}: {}", trim_error_body(&text)));
        }
        let parsed: Value =
            serde_json::from_str(&text).map_err(|err| format!("Invalid LLM JSON: {err}"))?;
        let content = parsed
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
            .and_then(|choice| choice.get("message"))
            .and_then(|message| message.get("content"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if content.is_empty() {
            return Err("LLM response did not contain assistant content".to_string());
        }
        Ok(content)
    }

    async fn stream_openai_like<F>(
        &self,
        url: &str,
        system: &str,
        user: &str,
        images: &[AgentImage],
        include_model: bool,
        on_delta: F,
    ) -> Result<String, String>
    where
        F: FnMut(&str) + Send,
    {
        let body = self.openai_like_body(system, user, images, include_model, true);
        let response = self
            .client
            .post(url)
            .headers(openai_headers(&self.config, url)?)
            .json(&body)
            .send()
            .await
            .map_err(|err| format!("LLM request failed: {err}"))?;
        collect_sse_text(response, parse_openai_delta, on_delta).await
    }

    fn anthropic_like_body(
        &self,
        system: &str,
        user: &str,
        images: &[AgentImage],
        stream: bool,
    ) -> Value {
        let mut body = json!({
            "model": self.config.model,
            "system": [{ "type": "text", "text": system, "cache_control": { "type": "ephemeral" } }],
            "messages": [{ "role": "user", "content": anthropic_user_content(user, images) }],
            "max_tokens": self.max_output_tokens(),
        });
        if stream {
            body["stream"] = Value::Bool(true);
        }
        apply_anthropic_reasoning(&mut body, self.config.reasoning.as_ref());
        body
    }

    async fn generate_anthropic_like(
        &self,
        url: &str,
        system: &str,
        user: &str,
        images: &[AgentImage],
    ) -> Result<String, String> {
        let body = self.anthropic_like_body(system, user, images, false);

        let response = self
            .client
            .post(url)
            .headers(anthropic_headers(&self.config, url)?)
            .json(&body)
            .send()
            .await
            .map_err(|err| format!("LLM request failed: {err}"))?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|err| format!("Failed to read LLM response: {err}"))?;
        if !status.is_success() {
            return Err(format!("LLM HTTP {status}: {}", trim_error_body(&text)));
        }
        let parsed: Value =
            serde_json::from_str(&text).map_err(|err| format!("Invalid LLM JSON: {err}"))?;
        let content = parsed
            .get("content")
            .and_then(Value::as_array)
            .map(|blocks| {
                blocks
                    .iter()
                    .filter_map(|block| {
                        if block.get("type").and_then(Value::as_str) == Some("text") {
                            block.get("text").and_then(Value::as_str)
                        } else {
                            None
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("")
            })
            .unwrap_or_default()
            .trim()
            .to_string();
        if content.is_empty() {
            return Err("LLM response did not contain assistant content".to_string());
        }
        Ok(content)
    }

    async fn stream_anthropic_like<F>(
        &self,
        url: &str,
        system: &str,
        user: &str,
        images: &[AgentImage],
        on_delta: F,
    ) -> Result<String, String>
    where
        F: FnMut(&str) + Send,
    {
        let body = self.anthropic_like_body(system, user, images, true);
        let response = self
            .client
            .post(url)
            .headers(anthropic_headers(&self.config, url)?)
            .json(&body)
            .send()
            .await
            .map_err(|err| format!("LLM request failed: {err}"))?;
        collect_sse_text(response, parse_anthropic_delta, on_delta).await
    }

    fn google_body(&self, system: &str, user: &str, images: &[AgentImage]) -> Value {
        let mut parts = vec![json!({ "text": user })];
        for image in images {
            parts.push(json!({
                "inlineData": {
                    "mimeType": image.media_type,
                    "data": image.data_base64
                }
            }));
        }
        let mut body = json!({
            "systemInstruction": {
                "parts": [{ "text": system }]
            },
            "contents": [{
                "role": "user",
                "parts": parts
            }],
            "generationConfig": {
                "maxOutputTokens": self.max_output_tokens()
            }
        });
        apply_google_reasoning(&mut body, self.config.reasoning.as_ref());
        body
    }

    async fn generate_google(
        &self,
        system: &str,
        user: &str,
        images: &[AgentImage],
    ) -> Result<String, String> {
        let encoded_model = url_encode_path_segment(&self.config.model);
        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{encoded_model}:generateContent"
        );
        let body = self.google_body(system, user, images);

        let response = self
            .client
            .post(url)
            .header("Content-Type", "application/json")
            .header("x-goog-api-key", self.config.api_key.trim())
            .json(&body)
            .send()
            .await
            .map_err(|err| format!("LLM request failed: {err}"))?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|err| format!("Failed to read LLM response: {err}"))?;
        if !status.is_success() {
            return Err(format!("LLM HTTP {status}: {}", trim_error_body(&text)));
        }
        let parsed: Value =
            serde_json::from_str(&text).map_err(|err| format!("Invalid LLM JSON: {err}"))?;
        let content = parsed
            .get("candidates")
            .and_then(Value::as_array)
            .and_then(|candidates| candidates.first())
            .and_then(|candidate| candidate.get("content"))
            .and_then(|content| content.get("parts"))
            .and_then(Value::as_array)
            .map(|parts| {
                parts
                    .iter()
                    .filter_map(|part| part.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("")
            })
            .unwrap_or_default()
            .trim()
            .to_string();
        if content.is_empty() {
            return Err("LLM response did not contain assistant content".to_string());
        }
        Ok(content)
    }

    async fn stream_google<F>(
        &self,
        system: &str,
        user: &str,
        images: &[AgentImage],
        on_delta: F,
    ) -> Result<String, String>
    where
        F: FnMut(&str) + Send,
    {
        let encoded_model = url_encode_path_segment(&self.config.model);
        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{encoded_model}:streamGenerateContent?alt=sse"
        );
        let body = self.google_body(system, user, images);
        let response = self
            .client
            .post(url)
            .header("Content-Type", "application/json")
            .header("x-goog-api-key", self.config.api_key.trim())
            .json(&body)
            .send()
            .await
            .map_err(|err| format!("LLM request failed: {err}"))?;
        collect_sse_text(response, parse_google_delta, on_delta).await
    }

    pub fn structured_task_config(&self, max_tokens: u32) -> Self {
        let mut config = self.config.clone();
        config.reasoning = Some(LlmReasoningConfig {
            mode: Some("off".to_string()),
            budget_tokens: None,
        });
        config.max_tokens = Some(max_tokens);
        Self {
            config,
            client: self.client.clone(),
        }
    }

    fn max_output_tokens(&self) -> u32 {
        self.config
            .max_tokens
            .unwrap_or(DEFAULT_MAX_TOKENS)
            .clamp(256, 32_768)
    }
}

fn openai_headers(config: &LlmConfig, url: &str) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    headers.insert("Content-Type", HeaderValue::from_static("application/json"));
    let key = config.api_key.trim();
    if !key.is_empty() {
        if is_azure_endpoint(url) {
            headers.insert(
                "api-key",
                HeaderValue::from_str(key)
                    .map_err(|err| format!("Invalid API key header: {err}"))?,
            );
        } else {
            headers.insert(
                "Authorization",
                HeaderValue::from_str(&format!("Bearer {key}"))
                    .map_err(|err| format!("Invalid authorization header: {err}"))?,
            );
        }
    }
    Ok(headers)
}

fn anthropic_headers(config: &LlmConfig, url: &str) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    headers.insert("Content-Type", HeaderValue::from_static("application/json"));
    headers.insert(
        "anthropic-version",
        HeaderValue::from_static(ANTHROPIC_VERSION),
    );
    let key = config.api_key.trim();
    if !key.is_empty() {
        let name = if requires_bearer_auth(url) {
            "Authorization"
        } else {
            "x-api-key"
        };
        let value = if name == "Authorization" {
            format!("Bearer {key}")
        } else {
            key.to_string()
        };
        headers.insert(
            HeaderName::from_static(name),
            HeaderValue::from_str(&value)
                .map_err(|err| format!("Invalid API key header: {err}"))?,
        );
    }
    Ok(headers)
}

fn openai_user_content(user: &str, images: &[AgentImage]) -> Value {
    if images.is_empty() {
        return Value::String(user.to_string());
    }
    let mut blocks = vec![json!({ "type": "text", "text": user })];
    for image in images {
        blocks.push(json!({
            "type": "image_url",
            "image_url": {
                "url": format!("data:{};base64,{}", image.media_type, image.data_base64)
            }
        }));
    }
    Value::Array(blocks)
}

fn anthropic_user_content(user: &str, images: &[AgentImage]) -> Value {
    let mut user_content = vec![json!({ "type": "text", "text": user })];
    for image in images {
        user_content.push(json!({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": image.media_type,
                "data": image.data_base64
            }
        }));
    }
    Value::Array(user_content)
}

async fn collect_sse_text<F>(
    response: reqwest::Response,
    parse_delta: fn(&str) -> Option<String>,
    mut on_delta: F,
) -> Result<String, String>
where
    F: FnMut(&str) + Send,
{
    let status = response.status();
    if !status.is_success() {
        let text = response
            .text()
            .await
            .map_err(|err| format!("Failed to read LLM response: {err}"))?;
        return Err(format!("LLM HTTP {status}: {}", trim_error_body(&text)));
    }

    let mut full = String::new();
    let mut buffer = Vec::<u8>::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|err| format!("LLM stream failed: {err}"))?;
        collect_sse_chunk_bytes(&mut buffer, &chunk, parse_delta, &mut on_delta, &mut full);
    }
    if !buffer.iter().all(|byte| byte.is_ascii_whitespace()) {
        collect_sse_line_bytes(&buffer, parse_delta, &mut on_delta, &mut full);
    }
    if full.trim().is_empty() {
        return Err("LLM response did not contain assistant content".to_string());
    }
    Ok(full.trim().to_string())
}

fn collect_sse_chunk_bytes<F>(
    buffer: &mut Vec<u8>,
    chunk: &[u8],
    parse_delta: fn(&str) -> Option<String>,
    on_delta: &mut F,
    full: &mut String,
) where
    F: FnMut(&str) + Send,
{
    buffer.extend_from_slice(chunk);
    while let Some(newline) = buffer.iter().position(|byte| *byte == b'\n') {
        let mut line = buffer.drain(..=newline).collect::<Vec<_>>();
        if line.last() == Some(&b'\n') {
            line.pop();
        }
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        collect_sse_line_bytes(&line, parse_delta, on_delta, full);
    }
}

fn collect_sse_line_bytes<F>(
    line: &[u8],
    parse_delta: fn(&str) -> Option<String>,
    on_delta: &mut F,
    full: &mut String,
) where
    F: FnMut(&str) + Send,
{
    let line = String::from_utf8_lossy(line);
    collect_sse_line(line.trim(), parse_delta, on_delta, full);
}

fn collect_sse_line<F>(
    line: &str,
    parse_delta: fn(&str) -> Option<String>,
    on_delta: &mut F,
    full: &mut String,
) where
    F: FnMut(&str) + Send,
{
    let Some(data) = line.strip_prefix("data:") else {
        return;
    };
    let data = data.trim();
    if data == "[DONE]" || data.is_empty() {
        return;
    }
    if let Some(delta) = parse_delta(data) {
        if !delta.is_empty() {
            on_delta(&delta);
            full.push_str(&delta);
        }
    }
}

fn parse_openai_delta(data: &str) -> Option<String> {
    let parsed: Value = serde_json::from_str(data).ok()?;
    parsed
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("delta").or_else(|| choice.get("message")))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn parse_anthropic_delta(data: &str) -> Option<String> {
    let parsed: Value = serde_json::from_str(data).ok()?;
    if parsed.get("type").and_then(Value::as_str) == Some("content_block_delta") {
        return parsed
            .get("delta")
            .and_then(|delta| delta.get("text"))
            .and_then(Value::as_str)
            .map(str::to_string);
    }
    None
}

fn parse_google_delta(data: &str) -> Option<String> {
    let parsed: Value = serde_json::from_str(data).ok()?;
    parsed
        .get("candidates")
        .and_then(Value::as_array)
        .and_then(|candidates| candidates.first())
        .and_then(|candidate| candidate.get("content"))
        .and_then(|content| content.get("parts"))
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("")
        })
        .filter(|text| !text.is_empty())
}

fn build_ollama_url(base: &str) -> String {
    let mut base = base.trim().trim_end_matches('/').to_string();
    if base.to_ascii_lowercase().ends_with("/v1/chat/completions") {
        base.truncate(base.len() - "/v1/chat/completions".len());
    } else if base.to_ascii_lowercase().ends_with("/v1") {
        base.truncate(base.len() - "/v1".len());
    }
    format!("{base}/v1/chat/completions")
}

fn build_custom_openai_url(config: &LlmConfig) -> String {
    let base = config.custom_endpoint.trim().trim_end_matches('/');
    if is_azure_endpoint(base) {
        return build_azure_url(config).unwrap_or_else(|_| base.to_string());
    }
    if base.to_ascii_lowercase().ends_with("/chat/completions") {
        base.to_string()
    } else {
        format!("{base}/chat/completions")
    }
}

fn build_azure_url(config: &LlmConfig) -> Result<String, String> {
    let endpoint = config.custom_endpoint.trim().trim_end_matches('/');
    if endpoint.is_empty() {
        return Err("Azure endpoint is required".to_string());
    }
    let api_version = config
        .azure_api_version
        .as_deref()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or(AZURE_OPENAI_API_VERSION);
    if endpoint
        .to_ascii_lowercase()
        .contains("/openai/deployments/")
    {
        let sep = if endpoint.contains('?') { '&' } else { '?' };
        return Ok(format!("{endpoint}{sep}api-version={api_version}"));
    }
    Ok(format!(
        "{endpoint}/openai/deployments/{}/chat/completions?api-version={api_version}",
        url_encode_path_segment(&config.model)
    ))
}

fn build_anthropic_url(base: &str) -> String {
    let base = base.trim().trim_end_matches('/');
    if base.to_ascii_lowercase().ends_with("/v1/messages") {
        base.to_string()
    } else if base.to_ascii_lowercase().ends_with("/v1") {
        format!("{base}/messages")
    } else {
        format!("{base}/v1/messages")
    }
}

fn is_azure_endpoint(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.contains(".openai.azure.com") || lower.contains("/openai/deployments/")
}

fn requires_bearer_auth(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.contains("minimax.io") || lower.contains("minimaxi.com")
}

fn apply_openai_reasoning(body: &mut Value, reasoning: Option<&LlmReasoningConfig>) {
    let Some(reasoning) = reasoning else {
        return;
    };
    match reasoning.mode.as_deref() {
        Some("off") => {}
        Some("low" | "medium" | "high") => {
            body["reasoning_effort"] = Value::String(reasoning.mode.clone().unwrap_or_default());
        }
        _ => {}
    }
}

fn apply_anthropic_reasoning(body: &mut Value, reasoning: Option<&LlmReasoningConfig>) {
    let Some(reasoning) = reasoning else {
        return;
    };
    if reasoning.mode.as_deref() == Some("off") {
        return;
    }
    let Some(budget) = reasoning_budget(reasoning) else {
        return;
    };
    body["thinking"] = json!({ "type": "enabled", "budget_tokens": budget });
    let min_tokens = budget.saturating_add(1024).max(DEFAULT_MAX_TOKENS);
    body["max_tokens"] = Value::from(min_tokens);
}

fn apply_google_reasoning(body: &mut Value, reasoning: Option<&LlmReasoningConfig>) {
    let Some(reasoning) = reasoning else {
        return;
    };
    if reasoning.mode.as_deref() == Some("off") {
        body["generationConfig"]["thinkingConfig"] = json!({ "thinkingBudget": 0 });
        return;
    }
    if let Some(budget) = reasoning_budget(reasoning) {
        body["generationConfig"]["thinkingConfig"] = json!({ "thinkingBudget": budget });
    }
}

fn reasoning_budget(reasoning: &LlmReasoningConfig) -> Option<u32> {
    match reasoning.mode.as_deref() {
        Some("custom") => reasoning.budget_tokens,
        Some("low") => Some(1024),
        Some("medium") => Some(4096),
        Some("high" | "max") => Some(8192),
        _ => None,
    }
}

fn trim_error_body(text: &str) -> String {
    const MAX: usize = 800;
    let trimmed = text.trim();
    if trimmed.chars().count() <= MAX {
        trimmed.to_string()
    } else {
        format!("{}...", trimmed.chars().take(MAX).collect::<String>())
    }
}

fn url_encode_path_segment(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(provider: &str) -> LlmConfig {
        LlmConfig {
            provider: provider.to_string(),
            api_key: "key".to_string(),
            model: "model/name".to_string(),
            ollama_url: "http://localhost:11434/v1".to_string(),
            custom_endpoint: "https://example.com/v1".to_string(),
            azure_api_version: None,
            api_mode: None,
            reasoning: None,
            max_tokens: None,
            max_context_size: None,
        }
    }

    #[test]
    fn ollama_url_normalizes_common_endpoint_shapes() {
        assert_eq!(
            build_ollama_url("http://localhost:11434"),
            "http://localhost:11434/v1/chat/completions"
        );
        assert_eq!(
            build_ollama_url("http://localhost:11434/v1"),
            "http://localhost:11434/v1/chat/completions"
        );
        assert_eq!(
            build_ollama_url("http://localhost:11434/v1/chat/completions"),
            "http://localhost:11434/v1/chat/completions"
        );
    }

    #[test]
    fn anthropic_url_normalizes_messages_endpoint() {
        assert_eq!(
            build_anthropic_url("https://api.anthropic.com"),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            build_anthropic_url("https://api.anthropic.com/v1"),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            build_anthropic_url("https://api.anthropic.com/v1/messages"),
            "https://api.anthropic.com/v1/messages"
        );
    }

    #[test]
    fn azure_url_uses_model_as_deployment_name() {
        let mut cfg = config("azure");
        cfg.custom_endpoint = "https://resource.openai.azure.com".to_string();
        cfg.model = "my deployment".to_string();
        assert_eq!(
            build_azure_url(&cfg).unwrap(),
            "https://resource.openai.azure.com/openai/deployments/my%20deployment/chat/completions?api-version=2024-10-21"
        );
    }

    #[test]
    fn usability_matches_existing_provider_requirements() {
        assert!(config("openai").is_usable_for_backend_http());
        assert!(config("anthropic").is_usable_for_backend_http());
        assert!(config("custom").is_usable_for_backend_http());
        assert!(config("ollama").is_usable_for_backend_http());
        assert!(!config("claude-code").is_usable_for_backend_http());
        let mut missing_key = config("openai");
        missing_key.api_key.clear();
        assert!(!missing_key.is_usable_for_backend_http());
    }

    #[test]
    fn llm_config_parses_existing_app_state_shape() {
        let cfg: LlmConfig = serde_json::from_value(json!({
            "provider": "custom",
            "apiKey": "key",
            "model": "model",
            "ollamaUrl": "",
            "customEndpoint": "https://example.com/v1",
            "apiMode": "anthropic_messages",
            "reasoning": {
                "mode": "custom",
                "budgetTokens": 4096
            }
        }))
        .unwrap();

        assert_eq!(cfg.api_key, "key");
        assert_eq!(cfg.api_mode.as_deref(), Some("anthropic_messages"));
        assert_eq!(
            cfg.reasoning.as_ref().and_then(|r| r.budget_tokens),
            Some(4096)
        );
        assert_eq!(cfg.max_tokens, None);
    }

    #[test]
    fn trim_error_body_is_utf8_safe() {
        let long = "错误".repeat(600);
        let trimmed = trim_error_body(&long);
        assert!(trimmed.ends_with("..."));
        assert!(trimmed.is_char_boundary(trimmed.len()));
    }

    #[test]
    fn openai_reasoning_off_does_not_emit_null_field() {
        let mut body = json!({});
        apply_openai_reasoning(
            &mut body,
            Some(&LlmReasoningConfig {
                mode: Some("off".to_string()),
                budget_tokens: None,
            }),
        );
        assert!(body.get("reasoning_effort").is_none());
    }

    #[test]
    fn structured_task_config_disables_reasoning_and_raises_output_budget() {
        let mut cfg = config("openai");
        cfg.reasoning = Some(LlmReasoningConfig {
            mode: Some("high".to_string()),
            budget_tokens: None,
        });
        let client = LlmClient::new(cfg).unwrap().structured_task_config(16_384);
        let body = client.openai_like_body("system", "user", &[], true, false);

        assert_eq!(body.get("max_tokens").and_then(Value::as_u64), Some(16_384));
        assert!(body.get("reasoning_effort").is_none());
    }

    #[test]
    fn parses_provider_stream_deltas() {
        assert_eq!(
            parse_openai_delta(r#"{"choices":[{"delta":{"content":"hello"}}]}"#).as_deref(),
            Some("hello")
        );
        assert_eq!(
            parse_anthropic_delta(
                r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"world"}}"#
            )
            .as_deref(),
            Some("world")
        );
        assert_eq!(
            parse_google_delta(r#"{"candidates":[{"content":{"parts":[{"text":"gemini"}]}}]}"#)
                .as_deref(),
            Some("gemini")
        );
    }

    #[test]
    fn collects_sse_line_without_trailing_newline() {
        let mut full = String::new();
        let mut deltas = Vec::new();
        collect_sse_line(
            r#"data: {"choices":[{"delta":{"content":"tail"}}]}"#,
            parse_openai_delta,
            &mut |delta| deltas.push(delta.to_string()),
            &mut full,
        );

        assert_eq!(full, "tail");
        assert_eq!(deltas, vec!["tail"]);
    }

    #[test]
    fn sse_byte_buffer_preserves_multibyte_utf8_across_chunks() {
        let line = r#"data: {"choices":[{"delta":{"content":"煤矿"}}]}
"#;
        let split = line.find("矿").unwrap() + 1;
        let mut buffer = Vec::new();
        let mut full = String::new();
        let mut deltas = Vec::new();

        collect_sse_chunk_bytes(
            &mut buffer,
            &line.as_bytes()[..split],
            parse_openai_delta,
            &mut |delta| deltas.push(delta.to_string()),
            &mut full,
        );
        assert!(full.is_empty());

        collect_sse_chunk_bytes(
            &mut buffer,
            &line.as_bytes()[split..],
            parse_openai_delta,
            &mut |delta| deltas.push(delta.to_string()),
            &mut full,
        );

        assert_eq!(full, "煤矿");
        assert_eq!(deltas, vec!["煤矿"]);
    }
}
