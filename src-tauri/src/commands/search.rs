use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use walkdir::WalkDir;

use crate::commands::vectorstore;
use crate::panic_guard::run_guarded_async;

const DEFAULT_RESULTS: usize = 20;
const MAX_RESULTS: usize = 50;
const RRF_K: f64 = 60.0;
const FILENAME_EXACT_BONUS: f64 = 200.0;
const PHRASE_IN_TITLE_BONUS: f64 = 50.0;
const PHRASE_IN_CONTENT_PER_OCC: f64 = 20.0;
const MAX_PHRASE_OCC_COUNTED: usize = 10;
const TITLE_TOKEN_WEIGHT: f64 = 5.0;
const CONTENT_TOKEN_WEIGHT: f64 = 1.0;
const SNIPPET_CONTEXT: usize = 80;
const SEARCH_EMBEDDING_TIMEOUT_SECS: u64 = 8;
const MAX_SEARCH_FILES: usize = 10_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchImageRef {
    pub url: String,
    pub alt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSearchResult {
    pub path: String,
    pub title: String,
    pub snippet: String,
    pub title_match: bool,
    pub score: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vector_score: Option<f32>,
    pub images: Vec<SearchImageRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSearchResponse {
    pub mode: String,
    pub results: Vec<ProjectSearchResult>,
    pub token_hits: usize,
    pub vector_hits: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchEmbeddingConfig {
    pub enabled: bool,
    pub endpoint: String,
    pub api_key: String,
    pub model: String,
    pub output_dimensionality: Option<u32>,
    /// Extra HTTP headers to send with every embedding request, e.g.
    /// `X-Model-Provider-Id: siliconflow` for the mify gateway.
    /// Reserved names (Authorization, Content-Type, Host,
    /// Content-Length) are skipped — they're managed by the client.
    #[serde(default)]
    pub extra_headers: Option<BTreeMap<String, String>>,
}

#[tauri::command]
pub async fn search_project(
    project_path: String,
    query: String,
    top_k: Option<usize>,
    include_content: Option<bool>,
    query_embedding: Option<Vec<f32>>,
    embedding_config: Option<SearchEmbeddingConfig>,
) -> Result<ProjectSearchResponse, String> {
    run_guarded_async("search_project", async move {
        let query_embedding =
            resolve_query_embedding(&query, query_embedding, embedding_config).await?;
        search_project_inner(
            project_path,
            query,
            top_k.unwrap_or(DEFAULT_RESULTS),
            include_content.unwrap_or(false),
            query_embedding,
        )
        .await
    })
    .await
}

pub async fn resolve_query_embedding(
    query: &str,
    explicit_embedding: Option<Vec<f32>>,
    embedding_config: Option<SearchEmbeddingConfig>,
) -> Result<Option<Vec<f32>>, String> {
    if let Some(embedding) = explicit_embedding {
        return validate_query_embedding(embedding).map(Some);
    }
    let Some(cfg) = embedding_config else {
        return Ok(None);
    };
    if !cfg.enabled || cfg.endpoint.trim().is_empty() || cfg.model.trim().is_empty() {
        return Ok(None);
    }
    match fetch_embedding(query, &cfg).await {
        Ok(embedding) => validate_query_embedding(embedding).map(Some),
        Err(err) => {
            eprintln!("[Search] embedding disabled for this request: {err}");
            Ok(None)
        }
    }
}

fn validate_query_embedding(embedding: Vec<f32>) -> Result<Vec<f32>, String> {
    if embedding.is_empty() {
        return Err("queryEmbedding must not be empty".to_string());
    }
    if embedding.iter().any(|v| !v.is_finite()) {
        return Err("queryEmbedding must contain only finite numbers".to_string());
    }
    Ok(embedding)
}

pub async fn search_project_inner(
    project_path: String,
    query: String,
    top_k: usize,
    include_content: bool,
    query_embedding: Option<Vec<f32>>,
) -> Result<ProjectSearchResponse, String> {
    if query.trim().is_empty() {
        return Err("query is required".to_string());
    }
    let limit = top_k.clamp(1, MAX_RESULTS);
    let tokens = tokenize_query(&query);
    let effective_tokens = if tokens.is_empty() {
        vec![query.trim().to_lowercase()]
    } else {
        tokens
    };
    let query_phrase = trim_query_punctuation(&query.to_lowercase());
    let mut results = Vec::new();
    let mut page_paths_by_stem = BTreeMap::new();

    let wiki_root = Path::new(&project_path).join("wiki");
    if wiki_root.exists() {
        let mut searched_files = 0usize;
        for entry in WalkDir::new(&wiki_root).into_iter().filter_map(Result::ok) {
            if !entry.file_type().is_file()
                || entry.path().extension().and_then(|s| s.to_str()) != Some("md")
            {
                continue;
            }
            searched_files += 1;
            if searched_files > MAX_SEARCH_FILES {
                eprintln!(
                    "[Search] stopped scanning wiki after {MAX_SEARCH_FILES} markdown files in {project_path}"
                );
                break;
            }
            let content = match fs::read_to_string(entry.path()) {
                Ok(content) => content,
                Err(_) => continue,
            };
            if let Some(stem) = entry.path().file_stem().and_then(|s| s.to_str()) {
                let previous = page_paths_by_stem.insert(
                    stem.to_string(),
                    relative_to_project(&project_path, entry.path()),
                );
                if let Some(previous) = previous {
                    eprintln!(
                        "[Search] duplicate wiki page stem '{stem}': '{previous}' and '{}' share one vector page_id",
                        relative_to_project(&project_path, entry.path())
                    );
                }
            }
            if let Some(hit) = score_file(
                &project_path,
                entry.path(),
                &content,
                &effective_tokens,
                &query_phrase,
                &query,
                include_content,
            ) {
                results.push(hit);
            }
        }
    }

    let mut token_sorted = (0..results.len()).collect::<Vec<_>>();
    token_sorted.sort_by(|a, b| {
        results[*b]
            .score
            .partial_cmp(&results[*a].score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| results[*a].path.cmp(&results[*b].path))
    });
    let mut token_rank = BTreeMap::new();
    for (idx, result_idx) in token_sorted.iter().enumerate() {
        let result = &results[*result_idx];
        token_rank.insert(normalize_path(&result.path), idx + 1);
    }

    let mut vector_rank: BTreeMap<String, usize> = BTreeMap::new();
    let mut vector_score: BTreeMap<String, f32> = BTreeMap::new();
    let mut vector_hits = 0;
    if let Some(embedding) = query_embedding {
        if !embedding.is_empty() {
            match search_by_embedding(&project_path, embedding, limit.max(10)).await {
                Ok(vector_results) => {
                    vector_hits = vector_results.len();
                    for (idx, vr) in vector_results.iter().enumerate() {
                        vector_rank.insert(vr.id.clone(), idx + 1);
                        vector_score.insert(vr.id.clone(), vr.score);
                    }
                    materialize_vector_only_results(
                        &vector_results,
                        &page_paths_by_stem,
                        &project_path,
                        &mut results,
                        include_content,
                    );
                }
                Err(err) => {
                    eprintln!(
                        "[Search] vector search failed; falling back to keyword results: {err}"
                    );
                }
            }
        }
    }

    if vector_hits == 0 {
        results.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.path.cmp(&b.path))
        });
        results.truncate(limit);
        return Ok(ProjectSearchResponse {
            mode: "keyword".to_string(),
            token_hits: token_rank.len(),
            vector_hits,
            results,
        });
    }

    apply_rrf_scores(&mut results, &token_rank, &vector_rank, &vector_score);

    results.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.path.cmp(&b.path))
    });
    results.truncate(limit);

    Ok(ProjectSearchResponse {
        mode: search_mode(token_rank.is_empty(), vector_hits).to_string(),
        token_hits: token_rank.len(),
        vector_hits,
        results,
    })
}

fn apply_rrf_scores(
    results: &mut [ProjectSearchResult],
    token_rank: &BTreeMap<String, usize>,
    vector_rank: &BTreeMap<String, usize>,
    vector_score: &BTreeMap<String, f32>,
) {
    for result in results {
        let token = token_rank.get(&normalize_path(&result.path)).copied();
        let vector = vector_rank.get(&file_stem(&result.path)).copied();
        let mut rrf = 0.0;
        if let Some(rank) = token {
            rrf += 1.0 / (RRF_K + rank as f64);
        }
        if let Some(rank) = vector {
            rrf += 1.0 / (RRF_K + rank as f64);
        }
        if let Some(score) = vector_score.get(&file_stem(&result.path)).copied() {
            result.vector_score = Some(score);
        }
        result.score = rrf;
    }
}

fn search_mode(token_rank_empty: bool, vector_hits: usize) -> &'static str {
    if vector_hits == 0 {
        "keyword"
    } else if token_rank_empty {
        "vector"
    } else {
        "hybrid"
    }
}

#[derive(Debug, Clone)]
struct PageVectorResult {
    id: String,
    score: f32,
    chunk_text: String,
    heading_path: String,
}

async fn search_by_embedding(
    project_path: &str,
    query_embedding: Vec<f32>,
    top_k: usize,
) -> Result<Vec<PageVectorResult>, String> {
    let raw_chunks = vectorstore::vector_search_chunks(
        project_path.to_string(),
        query_embedding,
        (top_k * 3).max(30),
    )
    .await?;
    if raw_chunks.is_empty() {
        return Ok(vec![]);
    }

    let mut by_page: BTreeMap<String, Vec<vectorstore::ChunkSearchResult>> = BTreeMap::new();
    for chunk in raw_chunks {
        by_page
            .entry(chunk.page_id.clone())
            .or_default()
            .push(chunk);
    }

    let mut ranked = Vec::new();
    for (id, mut chunks) in by_page {
        chunks.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.chunk_index.cmp(&b.chunk_index))
        });
        let top_chunk = chunks[0].clone();
        let top = top_chunk.score;
        let tail: f32 = chunks.iter().skip(1).map(|chunk| chunk.score).sum();
        let blended = top + (tail * 0.3).min((1.0 - top).max(0.0));
        ranked.push(PageVectorResult {
            id,
            score: blended,
            chunk_text: top_chunk.chunk_text,
            heading_path: top_chunk.heading_path,
        });
    }
    ranked.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.id.cmp(&b.id))
    });
    ranked.truncate(top_k);
    Ok(ranked)
}

fn materialize_vector_only_results(
    vector_results: &[PageVectorResult],
    page_paths_by_stem: &BTreeMap<String, String>,
    project_path: &str,
    results: &mut Vec<ProjectSearchResult>,
    include_content: bool,
) {
    let mut known: BTreeSet<String> = results.iter().map(|r| file_stem(&r.path)).collect();
    for vr in vector_results {
        if known.contains(&vr.id) {
            continue;
        }
        if let Some(rel) = page_paths_by_stem.get(&vr.id) {
            let path = Path::new(project_path).join(rel);
            let Ok(content) = fs::read_to_string(&path) else {
                continue;
            };
            let file_name = Path::new(&rel)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("");
            let title = extract_title(&content, file_name);
            let snippet = build_vector_snippet(vr);
            results.push(ProjectSearchResult {
                path: rel.clone(),
                title,
                snippet,
                title_match: false,
                score: 0.0,
                vector_score: Some(vr.score),
                images: extract_image_refs(&content),
                content: include_content.then_some(content),
            });
            known.insert(vr.id.clone());
        }
    }
}

fn build_vector_snippet(result: &PageVectorResult) -> String {
    let mut text = result.chunk_text.trim().replace('\n', " ");
    if text.is_empty() {
        return String::new();
    }
    if text.chars().count() > SNIPPET_CONTEXT * 2 {
        text = text.chars().take(SNIPPET_CONTEXT * 2).collect::<String>();
        text.push_str("...");
    }
    let heading = result.heading_path.trim();
    if heading.is_empty() {
        text
    } else {
        format!("{heading}: {text}")
    }
}

fn score_file(
    project_path: &str,
    path: &Path,
    content: &str,
    tokens: &[String],
    query_phrase: &str,
    query: &str,
    include_content: bool,
) -> Option<ProjectSearchResult> {
    let file_name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
    let title = extract_title(content, file_name);
    let title_text = format!("{title} {file_name}");
    let title_lower = title_text.to_lowercase();
    let content_lower = content.to_lowercase();
    let stem = file_name.trim_end_matches(".md").to_lowercase();

    let filename_exact = !query_phrase.is_empty() && stem == query_phrase;
    let title_has_phrase = !query_phrase.is_empty() && title_lower.contains(query_phrase);
    let content_phrase_occ =
        count_occurrences(&content_lower, query_phrase).min(MAX_PHRASE_OCC_COUNTED);
    let title_token_score = token_match_score(&title_text, tokens);
    let content_token_score = token_match_score(content, tokens);

    if !filename_exact
        && !title_has_phrase
        && content_phrase_occ == 0
        && title_token_score == 0
        && content_token_score == 0
    {
        return None;
    }

    let score = (if filename_exact {
        FILENAME_EXACT_BONUS
    } else {
        0.0
    }) + (if title_has_phrase {
        PHRASE_IN_TITLE_BONUS
    } else {
        0.0
    }) + content_phrase_occ as f64 * PHRASE_IN_CONTENT_PER_OCC
        + title_token_score as f64 * TITLE_TOKEN_WEIGHT
        + content_token_score as f64 * CONTENT_TOKEN_WEIGHT;

    let snippet_anchor = if content_phrase_occ > 0 {
        query_phrase.to_string()
    } else {
        tokens
            .iter()
            .find(|token| content_lower.contains(token.as_str()))
            .cloned()
            .unwrap_or_else(|| query.to_string())
    };

    Some(ProjectSearchResult {
        path: relative_to_project(project_path, path),
        title,
        snippet: build_snippet(content, &snippet_anchor),
        title_match: title_token_score > 0 || title_has_phrase,
        score,
        vector_score: None,
        images: extract_image_refs(content),
        content: include_content.then_some(content.to_string()),
    })
}

pub fn tokenize_query(query: &str) -> Vec<String> {
    let raw = query
        .to_lowercase()
        .split(is_query_separator)
        .filter(|token| token.chars().count() > 1)
        .filter(|token| !is_stop_word(token))
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();

    let mut out = Vec::new();
    for token in raw {
        let chars = token.chars().collect::<Vec<_>>();
        let has_cjk = chars.iter().any(|c| ('\u{3400}'..='\u{9fff}').contains(c));
        if has_cjk && chars.len() > 2 {
            for pair in chars.windows(2) {
                out.push(pair.iter().collect());
            }
            for ch in &chars {
                let s = ch.to_string();
                if !is_stop_word(&s) {
                    out.push(s);
                }
            }
            out.push(token);
        } else {
            out.push(token);
        }
    }
    out.into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn is_query_separator(c: char) -> bool {
    c.is_whitespace()
        || c.is_ascii_punctuation()
        || matches!(
            c,
            '，' | '。'
                | '！'
                | '？'
                | '、'
                | '；'
                | '：'
                | '“'
                | '”'
                | '‘'
                | '’'
                | '（'
                | '）'
                | '·'
                | '～'
                | '…'
        )
}

fn is_stop_word(token: &str) -> bool {
    matches!(
        token,
        "的" | "是"
            | "了"
            | "什么"
            | "在"
            | "有"
            | "和"
            | "与"
            | "对"
            | "从"
            | "the"
            | "is"
            | "a"
            | "an"
            | "what"
            | "how"
            | "are"
            | "was"
            | "were"
            | "do"
            | "does"
            | "did"
            | "be"
            | "been"
            | "being"
            | "have"
            | "has"
            | "had"
            | "it"
            | "its"
            | "in"
            | "on"
            | "at"
            | "to"
            | "for"
            | "of"
            | "with"
            | "by"
            | "this"
            | "that"
            | "these"
            | "those"
    )
}

fn trim_query_punctuation(value: &str) -> String {
    value.trim_matches(is_query_separator).to_string()
}

fn token_match_score(text: &str, tokens: &[String]) -> usize {
    let lower = text.to_lowercase();
    tokens
        .iter()
        .filter(|token| lower.contains(token.as_str()))
        .count()
}

fn count_occurrences(haystack: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return 0;
    }
    haystack.match_indices(needle).count()
}

pub fn extract_title(content: &str, file_name: &str) -> String {
    let has_frontmatter = content.starts_with("---");
    let mut in_frontmatter = has_frontmatter;
    let mut frontmatter_closed = false;
    for line in content.lines().skip(if has_frontmatter { 1 } else { 0 }) {
        let trimmed = line.trim();
        if in_frontmatter && trimmed == "---" {
            in_frontmatter = false;
            frontmatter_closed = true;
            continue;
        }
        if in_frontmatter && trimmed.starts_with("title:") {
            return trimmed
                .trim_start_matches("title:")
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .to_string();
        }
        if has_frontmatter && !frontmatter_closed {
            continue;
        }
        if let Some(title) = trimmed.strip_prefix("# ") {
            return title.trim().to_string();
        }
    }
    file_name.trim_end_matches(".md").replace('-', " ")
}

pub fn extract_image_refs(content: &str) -> Vec<SearchImageRef> {
    let mut out = Vec::new();
    let mut seen = BTreeSet::new();
    let mut rest = content;
    while let Some(start) = rest.find("![") {
        rest = &rest[start + 2..];
        let Some(alt_end) = rest.find("](") else {
            break;
        };
        let alt = &rest[..alt_end];
        rest = &rest[alt_end + 2..];
        let Some(url_end) = rest.find(')') else {
            break;
        };
        let url = &rest[..url_end];
        if !url.trim().is_empty()
            && !url.contains(char::is_whitespace)
            && seen.insert(url.to_string())
        {
            out.push(SearchImageRef {
                url: url.to_string(),
                alt: alt.to_string(),
            });
        }
        rest = &rest[url_end + 1..];
    }
    out
}

async fn fetch_embedding(text: &str, cfg: &SearchEmbeddingConfig) -> Result<Vec<f32>, String> {
    let is_google = is_google_embedding_config(cfg);
    let endpoint = if is_google {
        google_embedding_endpoint(cfg)
    } else {
        cfg.endpoint.trim().to_string()
    };
    let mut req = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(
            SEARCH_EMBEDDING_TIMEOUT_SECS,
        ))
        .build()
        .map_err(|e| format!("Embedding HTTP client error: {e}"))?
        .post(endpoint)
        .header("Content-Type", "application/json");
    if !cfg.api_key.trim().is_empty() {
        if is_google {
            req = req.header("x-goog-api-key", cfg.api_key.trim());
        } else {
            req = req.bearer_auth(cfg.api_key.trim());
        }
    }
    if let Some(extra) = cfg.extra_headers.as_ref() {
        for (name, value) in extra {
            let trimmed = name.trim();
            if trimmed.is_empty() {
                continue;
            }
            let lower = trimmed.to_ascii_lowercase();
            if matches!(
                lower.as_str(),
                "authorization" | "content-type" | "host" | "content-length"
            ) {
                continue;
            }
            req = req.header(trimmed, value.as_str());
        }
    }
    let body = if is_google {
        google_embedding_body(&cfg.model, text, cfg.output_dimensionality)
    } else {
        json!({ "model": cfg.model, "input": text })
    };
    let resp = req
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Embedding request failed: {e}"))?;
    let status = resp.status();
    let data: Value = resp
        .json()
        .await
        .map_err(|e| format!("Embedding response parse failed: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "Embedding API HTTP {status}: {}",
            data.to_string().chars().take(200).collect::<String>()
        ));
    }
    let values = if is_google {
        data.get("embedding")
            .and_then(|v| v.get("values"))
            .and_then(Value::as_array)
    } else {
        data.get("data")
            .and_then(Value::as_array)
            .and_then(|arr| arr.first())
            .and_then(|v| v.get("embedding"))
            .and_then(Value::as_array)
    }
    .ok_or_else(|| "Embedding response missing vector".to_string())?;
    let mut out = Vec::with_capacity(values.len());
    for value in values {
        let n = value
            .as_f64()
            .ok_or_else(|| "Embedding response contains non-number values".to_string())?;
        if !n.is_finite() {
            return Err("Embedding response contains non-finite values".to_string());
        }
        out.push(n as f32);
    }
    if out.is_empty() {
        return Err("Embedding response vector is empty".to_string());
    }
    Ok(out)
}

fn is_google_embedding_config(cfg: &SearchEmbeddingConfig) -> bool {
    let endpoint = cfg.endpoint.to_lowercase();
    endpoint.contains("generativelanguage.googleapis.com") || endpoint.contains(":embedcontent")
}

fn google_embedding_endpoint(cfg: &SearchEmbeddingConfig) -> String {
    let raw = strip_google_api_key_query(cfg.endpoint.trim())
        .trim_end_matches('/')
        .to_string();
    if raw.to_lowercase().contains(":batchembedcontents") {
        return raw
            .replace(":batchEmbedContents", ":embedContent")
            .replace(":batchembedcontents", ":embedContent");
    }
    if raw.to_lowercase().contains(":embedcontent") {
        return raw;
    }
    let model = cfg.model.trim().trim_start_matches("models/");
    if raw.to_lowercase().contains("/models/") {
        format!("{raw}:embedContent")
    } else {
        format!("{raw}/models/{model}:embedContent")
    }
}

fn strip_google_api_key_query(endpoint: &str) -> String {
    if !endpoint.contains('?') {
        return endpoint.to_string();
    }
    match reqwest::Url::parse(endpoint) {
        Ok(mut url) => {
            let kept = url
                .query_pairs()
                .filter(|(key, _)| !key.eq_ignore_ascii_case("key"))
                .map(|(key, value)| (key.into_owned(), value.into_owned()))
                .collect::<Vec<_>>();
            url.query_pairs_mut().clear().extend_pairs(kept);
            url.to_string().trim_end_matches('?').to_string()
        }
        Err(_) => endpoint
            .split_once('?')
            .map(|(base, query)| {
                let kept = query
                    .split('&')
                    .filter(|pair| {
                        let key = pair.split_once('=').map(|(k, _)| k).unwrap_or(*pair);
                        !key.eq_ignore_ascii_case("key")
                    })
                    .collect::<Vec<_>>();
                if kept.is_empty() {
                    base.to_string()
                } else {
                    format!("{base}?{}", kept.join("&"))
                }
            })
            .unwrap_or_else(|| endpoint.to_string()),
    }
}

fn google_embedding_body(model: &str, text: &str, output_dimensionality: Option<u32>) -> Value {
    let model_path = if model.trim().starts_with("models/") {
        model.trim().to_string()
    } else {
        format!("models/{}", model.trim())
    };
    let mut body = json!({
        "model": model_path,
        "content": { "parts": [{ "text": text }] },
    });
    if let Some(dim) = output_dimensionality.filter(|dim| *dim > 0) {
        body["output_dimensionality"] = json!(dim);
    }
    body
}

pub fn build_snippet(content: &str, query: &str) -> String {
    let lower = content.to_lowercase();
    let q = query.to_lowercase();
    let idx = lower.find(&q).unwrap_or(0);
    let char_positions: Vec<usize> = content.char_indices().map(|(idx, _)| idx).collect();
    if char_positions.is_empty() {
        return String::new();
    }
    let match_char = char_positions
        .iter()
        .position(|byte| *byte >= idx)
        .unwrap_or(char_positions.len().saturating_sub(1));
    let query_chars = query.chars().count().max(1);
    let start_char = match_char.saturating_sub(SNIPPET_CONTEXT);
    let end_char = (match_char + query_chars + SNIPPET_CONTEXT).min(char_positions.len());
    let start = char_positions[start_char];
    let end = if end_char < char_positions.len() {
        char_positions[end_char]
    } else {
        content.len()
    };
    let mut snippet = content[start..end].replace('\n', " ");
    if start > 0 {
        snippet = format!("...{snippet}");
    }
    if end < content.len() {
        snippet.push_str("...");
    }
    snippet
}

fn normalize_path(path: &str) -> String {
    path.replace('\\', "/")
}

fn relative_to_project(project_path: &str, path: &Path) -> String {
    let root = Path::new(project_path);
    path.strip_prefix(root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/"))
}

fn file_stem(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn tmp_project() -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let id = COUNTER.fetch_add(1, Ordering::SeqCst);
        let path = std::env::temp_dir().join(format!("llm-wiki-search-test-{id}"));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(path.join("wiki/concepts")).unwrap();
        path
    }

    fn write_page(root: &Path, rel: &str, content: &str) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn result(path: &str) -> ProjectSearchResult {
        ProjectSearchResult {
            path: path.to_string(),
            title: path.to_string(),
            snippet: String::new(),
            title_match: false,
            score: 0.0,
            vector_score: None,
            images: vec![],
            content: None,
        }
    }

    #[test]
    fn tokenizes_cjk_bigrams_and_chars() {
        let tokens = tokenize_query("默会知识");
        assert!(tokens.contains(&"默会".to_string()));
        assert!(tokens.contains(&"知识".to_string()));
        assert!(tokens.contains(&"默".to_string()));
    }

    #[test]
    fn extracts_image_refs_without_duplicates() {
        let refs = extract_image_refs("![a](wiki/media/x.png)\n![b](wiki/media/x.png)");
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].alt, "a");
    }

    #[test]
    fn extract_title_uses_frontmatter_or_heading_not_body_title_lines() {
        let with_frontmatter = "---\ntitle: Real Title\n---\n\ntitle: Body Label\n# Heading";
        assert_eq!(
            extract_title(with_frontmatter, "fallback-name.md"),
            "Real Title"
        );

        let without_frontmatter = "intro\ntitle: Body Label\n# Real Heading";
        assert_eq!(
            extract_title(without_frontmatter, "fallback-name.md"),
            "Real Heading"
        );

        assert_eq!(
            extract_title("plain body", "vector-database.md"),
            "vector database"
        );
    }

    #[test]
    fn explicit_query_embedding_is_validated() {
        assert!(validate_query_embedding(vec![0.1, 0.2]).is_ok());
        assert!(validate_query_embedding(vec![]).is_err());
        assert!(validate_query_embedding(vec![f32::NAN]).is_err());
        assert!(validate_query_embedding(vec![f32::INFINITY]).is_err());
    }

    #[test]
    fn google_embedding_endpoint_strips_key_and_normalizes_batch_endpoint() {
        let cfg = SearchEmbeddingConfig {
            enabled: true,
            endpoint: "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents?key=URL_KEY&alt=json".to_string(),
            api_key: "HEADER_KEY".to_string(),
            model: "gemini-embedding-001".to_string(),
            output_dimensionality: Some(768),
            extra_headers: None,
        };

        let endpoint = google_embedding_endpoint(&cfg);
        assert!(endpoint.contains(":embedContent"));
        assert!(!endpoint.contains(":batchEmbedContents"));
        assert!(!endpoint.contains("URL_KEY"));
        assert!(endpoint.contains("alt=json"));

        let body = google_embedding_body("gemini-embedding-001", "hello", Some(768));
        assert_eq!(body["model"], "models/gemini-embedding-001");
        assert_eq!(body["output_dimensionality"], 768);
    }

    #[test]
    fn rrf_combines_token_and_vector_ranks_and_keeps_vector_score() {
        let mut results = vec![
            result("wiki/concepts/both.md"),
            result("wiki/concepts/token-only.md"),
            result("wiki/concepts/vector-only.md"),
        ];
        let token_rank = BTreeMap::from([
            ("wiki/concepts/both.md".to_string(), 1),
            ("wiki/concepts/token-only.md".to_string(), 2),
        ]);
        let vector_rank = BTreeMap::from([("both".to_string(), 1), ("vector-only".to_string(), 2)]);
        let vector_score =
            BTreeMap::from([("both".to_string(), 0.95), ("vector-only".to_string(), 0.8)]);

        apply_rrf_scores(&mut results, &token_rank, &vector_rank, &vector_score);
        results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap());

        assert_eq!(results[0].path, "wiki/concepts/both.md");
        assert!((results[0].score - (1.0 / 61.0 + 1.0 / 61.0)).abs() < 0.000001);
        assert_eq!(results[0].vector_score, Some(0.95));
        assert!((results[1].score - (1.0 / 62.0)).abs() < 0.000001);
        assert!((results[2].score - (1.0 / 62.0)).abs() < 0.000001);
    }

    #[test]
    fn search_mode_distinguishes_keyword_vector_and_hybrid() {
        assert_eq!(search_mode(false, 0), "keyword");
        assert_eq!(search_mode(true, 3), "vector");
        assert_eq!(search_mode(false, 3), "hybrid");
    }

    #[test]
    fn vector_only_materialization_uses_chunk_snippet_and_any_wiki_subdir() {
        let root = tmp_project();
        write_page(
            &root,
            "wiki/custom/deep-page.md",
            "---\ntitle: Deep Page\n---\n\n# Deep Page\n\nThe literal query is absent here.",
        );
        let vector_results = vec![PageVectorResult {
            id: "deep-page".to_string(),
            score: 0.91,
            chunk_text: "A semantic chunk explains the actual reason for retrieval.".to_string(),
            heading_path: "Section > Detail".to_string(),
        }];
        let mut results = Vec::new();
        let pages = BTreeMap::from([(
            "deep-page".to_string(),
            "wiki/custom/deep-page.md".to_string(),
        )]);

        materialize_vector_only_results(
            &vector_results,
            &pages,
            &root.to_string_lossy(),
            &mut results,
            false,
        );

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].path, "wiki/custom/deep-page.md");
        assert_eq!(results[0].title, "Deep Page");
        assert_eq!(results[0].vector_score, Some(0.91));
        assert!(results[0].snippet.contains("Section > Detail"));
        assert!(results[0].snippet.contains("semantic chunk"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn vector_snippet_empty_chunk_does_not_echo_query() {
        let vector = PageVectorResult {
            id: "empty".to_string(),
            score: 0.5,
            chunk_text: "  ".to_string(),
            heading_path: "Heading".to_string(),
        };

        assert_eq!(build_vector_snippet(&vector), "");
    }

    #[tokio::test]
    async fn keyword_search_prefers_filename_exact_match() {
        let root = tmp_project();
        write_page(
            &root,
            "wiki/concepts/attention.md",
            "---\ntitle: Attention\n---\n\n# Attention\n\nbody about attention.",
        );
        write_page(
            &root,
            "wiki/concepts/random.md",
            "---\ntitle: Random\n---\n\n# Random\n\nattention is mentioned briefly.",
        );

        let out = search_project_inner(
            root.to_string_lossy().to_string(),
            "attention".into(),
            20,
            false,
            None,
        )
        .await
        .unwrap();

        assert_eq!(out.mode, "keyword");
        assert_eq!(out.results[0].title, "Attention");
        assert!(out.results[0].title_match);
        assert!(out.results[0].score > 100.0);
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn keyword_search_handles_cjk_bigram_queries() {
        let root = tmp_project();
        write_page(
            &root,
            "wiki/concepts/tacit.md",
            "---\ntitle: 默会知识\n---\n\n# 默会知识\n\n默会知识强调难以言明的实践经验。",
        );

        let out = search_project_inner(
            root.to_string_lossy().to_string(),
            "默会知识".into(),
            20,
            false,
            None,
        )
        .await
        .unwrap();

        assert_eq!(out.results[0].title, "默会知识");
        assert!(out.results[0].snippet.contains("默会知识"));
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn keyword_search_phrase_in_content_beats_scattered_tokens() {
        let root = tmp_project();
        write_page(
            &root,
            "wiki/concepts/phrase.md",
            "---\ntitle: Phrase\n---\n\n# Phrase\n\nThe phrase vector database appears together.",
        );
        write_page(
            &root,
            "wiki/concepts/scattered.md",
            "---\ntitle: Scattered\n---\n\n# Scattered\n\nvector appears here. database appears later.",
        );

        let out = search_project_inner(
            root.to_string_lossy().to_string(),
            "vector database".into(),
            20,
            false,
            None,
        )
        .await
        .unwrap();

        assert_eq!(out.results[0].title, "Phrase");
        let _ = fs::remove_dir_all(root);
    }
}
