use serde::{Deserialize, Serialize};

use crate::agent::tools::{run_anytxt_search, run_web_search, AnyTxtConfig, WebSearchConfig};
use crate::panic_guard::run_guarded_async;

/// Frontend-facing search result shape. The Rust Agent uses
/// `AgentReference` internally, but UI/deep-research code historically
/// consumes `{ title, url, snippet, source }`; keep that wire contract
/// stable while moving provider/network logic to Rust.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub source: String,
}

#[tauri::command]
pub async fn web_search(
    query: String,
    config: WebSearchConfig,
    max_results: Option<usize>,
) -> Result<Vec<ExternalSearchResult>, String> {
    run_guarded_async("web_search", async move {
        let references = run_web_search(&query, Some(config), max_results.unwrap_or(10)).await?;
        Ok(references
            .into_iter()
            .map(|item| ExternalSearchResult {
                title: item.title,
                source: hostname_label(&item.path).unwrap_or_else(|| "web".to_string()),
                url: item.path,
                snippet: item.snippet.unwrap_or_default(),
            })
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn anytxt_search(
    query: String,
    config: AnyTxtConfig,
    max_results: Option<usize>,
) -> Result<Vec<ExternalSearchResult>, String> {
    run_guarded_async("anytxt_search", async move {
        let references = run_anytxt_search(&query, Some(config), max_results.unwrap_or(20)).await?;
        Ok(references
            .into_iter()
            .map(|item| ExternalSearchResult {
                title: item.title,
                url: file_url_for_path(&item.path),
                snippet: item.snippet.unwrap_or_default(),
                source: "AnyTXT".to_string(),
            })
            .collect())
    })
    .await
}

fn hostname_label(url: &str) -> Option<String> {
    let host = reqwest::Url::parse(url).ok()?.host_str()?.to_string();
    Some(host.strip_prefix("www.").unwrap_or(&host).to_string())
}

pub(crate) fn file_url_for_path(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    if normalized.is_empty() || normalized.contains("://") {
        return normalized;
    }
    if normalized.starts_with("//") {
        return format!("file:{normalized}");
    }
    if normalized.len() >= 3
        && normalized.as_bytes()[1] == b':'
        && normalized.as_bytes()[2] == b'/'
        && normalized.as_bytes()[0].is_ascii_alphabetic()
    {
        return format!("file:///{}", encode_file_url_path(&normalized));
    }
    if normalized.starts_with('/') {
        return format!("file://{}", encode_file_url_path(&normalized));
    }
    normalized
}

fn encode_file_url_path(path: &str) -> String {
    path.split('/')
        .map(percent_encode_file_segment)
        .collect::<Vec<_>>()
        .join("/")
}

fn percent_encode_file_segment(segment: &str) -> String {
    let mut out = String::new();
    for byte in segment.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'.' | b'_' | b'~' | b':') {
            out.push(*byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::file_url_for_path;

    #[test]
    fn anytxt_paths_are_returned_as_file_urls_for_frontend_results() {
        assert_eq!(
            file_url_for_path(r"C:\docs\煤矿 安全.pdf"),
            "file:///C:/docs/%E7%85%A4%E7%9F%BF%20%E5%AE%89%E5%85%A8.pdf"
        );
        assert_eq!(
            file_url_for_path("/Users/me/docs/a b.txt"),
            "file:///Users/me/docs/a%20b.txt"
        );
        assert_eq!(file_url_for_path("anytxt://99"), "anytxt://99");
    }
}
