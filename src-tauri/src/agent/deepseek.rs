//! Official DeepSeek Search / Fetch transport. Credentials never enter URLs,
//! response excerpts, or diagnostics returned to the UI / Agent.
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};

use crate::commands::external_search::{hostname_label, ExternalSearchResult};

const API_BASE: &str = "https://api.deepseek.com/v1/tools";
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Deserialize)]
struct SearchResponse {
    results: Vec<SearchItem>,
}

#[derive(Deserialize)]
struct SearchItem {
    title: String,
    url: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    snippet: String,
    #[serde(default)]
    site_name: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct FetchResult {
    pub title: String,
    pub content: String,
}

pub async fn search(
    query: &str,
    key: &str,
    count: usize,
) -> Result<Vec<ExternalSearchResult>, String> {
    // Count Unicode characters, not UTF-8 bytes. Never truncate operators or
    // quoted phrases to make an overlong query fit the provider's limit.
    if query.trim().is_empty() || query.chars().count() > 128 {
        return Err("DeepSeek Search query must contain 1–128 Unicode characters and cannot be blank. Shorten the query and try again.".to_string());
    }
    let response: SearchResponse = request(
        "search",
        key,
        json!({ "query": query, "count": count.clamp(1, 50), "need_content": false }),
    )
    .await?;
    Ok(response
        .results
        .into_iter()
        .filter(|item| valid_page_url(&item.url))
        .take(count.clamp(1, 50))
        .map(|item| ExternalSearchResult {
            source: item
                .site_name
                .filter(|name| !name.trim().is_empty())
                .or_else(|| hostname_label(&item.url))
                .unwrap_or_else(|| "web".to_string()),
            title: item.title,
            url: item.url,
            snippet: if item.summary.trim().is_empty() {
                item.snippet
            } else {
                item.summary
            },
        })
        .collect())
}

pub async fn fetch(url: &str, key: &str) -> Result<FetchResult, String> {
    if !valid_page_url(url) {
        return Err("DeepSeek Fetch requires an HTTP(S) URL with a host, no embedded credentials, and at most 8192 characters.".to_string());
    }
    let page: FetchResult = request("fetch", key, json!({ "url": url })).await?;
    if page.content.trim().is_empty() {
        return Err("DeepSeek Fetch returned no extractable Markdown for this page.".to_string());
    }
    Ok(page)
}

fn valid_page_url(value: &str) -> bool {
    if value.is_empty() || value.chars().count() > 8192 {
        return false;
    }
    reqwest::Url::parse(value).is_ok_and(|url| {
        matches!(url.scheme(), "http" | "https")
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
    })
}

async fn request<T: DeserializeOwned>(
    operation: &str,
    key: &str,
    body: Value,
) -> Result<T, String> {
    let key = key.trim();
    if key.is_empty() {
        return Err(
            "DeepSeek Search & Fetch requires an API key in Web Search Settings.".to_string(),
        );
    }
    let client = crate::proxy::configure_http_client(reqwest::Client::builder())
        .timeout(std::time::Duration::from_secs(30))
        // These are fixed official endpoints; never follow a redirect with
        // an authenticated request to another service.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Failed to build DeepSeek HTTP client.".to_string())?;
    let mut response = client
        .post(format!("{API_BASE}/{operation}"))
        .bearer_auth(key)
        .header("Accept", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                format!("DeepSeek {operation} timed out. Try again later.")
            } else {
                format!(
                    "Could not reach DeepSeek {operation}. Check your network and proxy settings."
                )
            }
        })?;
    let status = response.status();
    if !status.is_success() {
        // Provider errors can echo request data. Return actionable status
        // guidance without copying response bodies or request headers.
        let hint = match status.as_u16() {
            401 | 403 => "Authentication failed. Check your DeepSeek API key and permissions.",
            402 => "Insufficient balance. Top up your DeepSeek account before retrying.",
            404 if operation == "fetch" => "No extractable Markdown for this page (site policy, unsupported content, or target error).",
            408 => "The request timed out. Try again later.",
            429 => "Rate limit reached. Wait before retrying (Fetch also has per-domain limits).",
            500..=599 => "The service is temporarily unavailable. Try again later.",
            _ => "Check the request and your DeepSeek account before retrying.",
        };
        return Err(format!(
            "DeepSeek {operation} failed (HTTP {}): {hint}",
            status.as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_RESPONSE_BYTES as u64)
    {
        return Err(format!(
            "DeepSeek {operation} response exceeds the 8 MiB limit."
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| format!("Failed to read DeepSeek {operation} response. Try again later."))?
    {
        if chunk.len() > MAX_RESPONSE_BYTES - bytes.len() {
            return Err(format!(
                "DeepSeek {operation} response exceeds the 8 MiB limit."
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| {
        format!(
            "DeepSeek {operation} returned an invalid JSON response or unexpected response shape."
        )
    })
}
