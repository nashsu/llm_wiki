use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};
use walkdir::WalkDir;

use super::search::{
    fetch_embedding_batch, fetch_embedding_with_retry, supports_embedding_batch,
    SearchEmbeddingConfig,
};
use super::vectorstore::{self, ChunkUpsertInput};

const DEFAULT_CHUNK_CHARS: usize = 1_000;
const DEFAULT_OVERLAP_CHARS: usize = 200;
const MIN_CHUNK_CHARS: usize = 64;
const MAX_CHUNK_CHARS: usize = 32_000;
const MAX_PAGE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_PAGE_CHUNKS: usize = 512;
const EMBEDDING_BATCH_SIZE: usize = 64;
const PROVIDER_PHASE_TIMEOUT: Duration = Duration::from_secs(300);
const REVISION_DIR: &str = ".llm-wiki/embedding-revisions";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageEmbeddingResult {
    pub path: String,
    pub page_id: String,
    pub revision: String,
    pub chunks: usize,
    pub vectors_written: usize,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PageEmbeddingErrorKind {
    InvalidRequest,
    NotFound,
    Provider,
    Storage,
    Conflict,
    Timeout,
}

#[derive(Debug, Clone)]
pub struct PageEmbeddingError {
    pub kind: PageEmbeddingErrorKind,
    pub message: String,
}

impl PageEmbeddingError {
    fn new(kind: PageEmbeddingErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MarkdownChunk {
    text: String,
    heading_path: String,
}

pub async fn embed_wiki_page(
    project_path: &str,
    relative_path: &str,
    config: SearchEmbeddingConfig,
    force: bool,
) -> Result<PageEmbeddingResult, PageEmbeddingError> {
    if !config.enabled || config.model.trim().is_empty() {
        return Err(PageEmbeddingError::new(
            PageEmbeddingErrorKind::InvalidRequest,
            "Embedding is not enabled or no embedding model is configured",
        ));
    }

    let (page_path, normalized_path) = resolve_wiki_markdown_path(project_path, relative_path)?;
    let metadata = fs::metadata(&page_path).map_err(|err| {
        PageEmbeddingError::new(
            PageEmbeddingErrorKind::NotFound,
            format!("Failed to inspect wiki page: {err}"),
        )
    })?;
    if metadata.len() > MAX_PAGE_BYTES {
        return Err(PageEmbeddingError::new(
            PageEmbeddingErrorKind::InvalidRequest,
            format!(
                "Wiki page exceeds the {} MiB indexing limit",
                MAX_PAGE_BYTES / 1024 / 1024
            ),
        ));
    }
    let content = fs::read_to_string(&page_path).map_err(|err| {
        let kind = if err.kind() == std::io::ErrorKind::NotFound {
            PageEmbeddingErrorKind::NotFound
        } else {
            PageEmbeddingErrorKind::InvalidRequest
        };
        PageEmbeddingError::new(
            kind,
            format!("Failed to read wiki page as UTF-8 text: {err}"),
        )
    })?;

    let page_id = page_path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            PageEmbeddingError::new(
                PageEmbeddingErrorKind::InvalidRequest,
                "Invalid wiki page name",
            )
        })?
        .to_string();
    vectorstore::validate_page_id_for_v2(&page_id)
        .map_err(|err| PageEmbeddingError::new(PageEmbeddingErrorKind::InvalidRequest, err))?;
    if matches!(
        page_id.to_ascii_lowercase().as_str(),
        "index" | "log" | "overview"
    ) {
        return Err(PageEmbeddingError::new(
            PageEmbeddingErrorKind::InvalidRequest,
            "Aggregate wiki pages index.md, log.md, and overview.md are maintained by the app and are not vector-indexed",
        ));
    }
    ensure_unique_page_stem(project_path, &page_path, &page_id)?;

    let revision = format!("sha256:{:x}", Sha256::digest(content.as_bytes()));
    let fingerprint = embedding_fingerprint(&revision, &config);
    if !force {
        let existing_chunks =
            vectorstore::vector_page_revision_match(project_path, &page_id, &fingerprint)
                .await
                .map_err(|err| PageEmbeddingError::new(PageEmbeddingErrorKind::Storage, err))?;
        if let Some(existing_chunks) = existing_chunks {
            return Ok(PageEmbeddingResult {
                path: normalized_path,
                page_id,
                revision,
                chunks: existing_chunks,
                vectors_written: 0,
                status: "unchanged".to_string(),
            });
        }
    }

    let title = extract_title(&content, &page_id);
    let chunk_chars = config
        .max_chunk_chars
        .unwrap_or(DEFAULT_CHUNK_CHARS)
        .clamp(MIN_CHUNK_CHARS, MAX_CHUNK_CHARS);
    let overlap_chars = config
        .overlap_chunk_chars
        .unwrap_or(DEFAULT_OVERLAP_CHARS)
        .min(chunk_chars / 2);
    let chunks = chunk_markdown(&content, chunk_chars, overlap_chars);
    if chunks.is_empty() {
        return Err(PageEmbeddingError::new(
            PageEmbeddingErrorKind::InvalidRequest,
            "Wiki page has no indexable content",
        ));
    }
    if chunks.len() > MAX_PAGE_CHUNKS {
        return Err(PageEmbeddingError::new(
            PageEmbeddingErrorKind::InvalidRequest,
            format!(
                "Wiki page produces {} chunks, exceeding the {} chunk limit; increase maxChunkChars or split the page",
                chunks.len(), MAX_PAGE_CHUNKS
            ),
        ));
    }

    // Only provider work is cancellable. Once storage replacement starts, let
    // it complete so a timeout cannot remove the previous page index midway.
    let rows = tokio::time::timeout(
        PROVIDER_PHASE_TIMEOUT,
        prepare_embedding_rows(&title, &chunks, &config),
    )
    .await
    .map_err(|_| {
        PageEmbeddingError::new(
            PageEmbeddingErrorKind::Timeout,
            format!(
                "Embedding provider timed out after {} seconds",
                PROVIDER_PHASE_TIMEOUT.as_secs()
            ),
        )
    })??;
    validate_embedding_rows(&rows)?;

    vectorstore::vector_upsert_chunks_with_revision(project_path, &page_id, rows, &fingerprint)
        .await
        .map_err(|err| PageEmbeddingError::new(PageEmbeddingErrorKind::Storage, err))?;
    Ok(PageEmbeddingResult {
        path: normalized_path,
        page_id,
        revision,
        chunks: chunks.len(),
        vectors_written: chunks.len(),
        status: "indexed".to_string(),
    })
}

fn validate_embedding_rows(rows: &[ChunkUpsertInput]) -> Result<(), PageEmbeddingError> {
    let Some(expected) = rows.first().map(|row| row.embedding.len()) else {
        return Err(PageEmbeddingError::new(
            PageEmbeddingErrorKind::Provider,
            "Embedding provider returned no vectors",
        ));
    };
    if expected == 0 || rows.iter().any(|row| row.embedding.len() != expected) {
        return Err(PageEmbeddingError::new(
            PageEmbeddingErrorKind::Provider,
            "Embedding provider returned empty or inconsistent vector dimensions",
        ));
    }
    Ok(())
}

async fn prepare_embedding_rows(
    title: &str,
    chunks: &[MarkdownChunk],
    config: &SearchEmbeddingConfig,
) -> Result<Vec<ChunkUpsertInput>, PageEmbeddingError> {
    // Build every vector before replacing the page in LanceDB. A provider
    // failure therefore leaves the previous, known-good page index intact.
    let mut rows = Vec::with_capacity(chunks.len());
    if supports_embedding_batch(&config) {
        for batch in chunks.chunks(EMBEDDING_BATCH_SIZE) {
            let texts = batch
                .iter()
                .map(|chunk| enrich_chunk(&title, chunk))
                .collect::<Vec<_>>();
            let embeddings = fetch_embedding_batch(&texts, &config)
                .await
                .map_err(|err| PageEmbeddingError::new(PageEmbeddingErrorKind::Provider, err))?;
            if embeddings.len() != batch.len() {
                return Err(PageEmbeddingError::new(
                    PageEmbeddingErrorKind::Provider,
                    "Embedding provider returned an incomplete batch",
                ));
            }
            for (chunk, embedding) in batch.iter().zip(embeddings) {
                rows.push(chunk_row(rows.len(), chunk, embedding));
            }
        }
    } else {
        for (index, chunk) in chunks.iter().enumerate() {
            let embedding_text = enrich_chunk(&title, chunk);
            let embedding = fetch_embedding_with_retry(&embedding_text, &config, 3)
                .await
                .map_err(|err| PageEmbeddingError::new(PageEmbeddingErrorKind::Provider, err))?;
            rows.push(chunk_row(index, chunk, embedding));
        }
    }
    Ok(rows)
}

fn chunk_row(index: usize, chunk: &MarkdownChunk, embedding: Vec<f32>) -> ChunkUpsertInput {
    ChunkUpsertInput {
        chunk_index: index as u32,
        chunk_text: chunk.text.clone(),
        heading_path: chunk.heading_path.clone(),
        embedding,
    }
}

fn embedding_fingerprint(revision: &str, config: &SearchEmbeddingConfig) -> String {
    let signature = serde_json::json!({
        "revision": revision,
        "endpoint": config.endpoint.trim(),
        "model": config.model.trim(),
        "outputDimensionality": config.output_dimensionality,
        "extraHeaders": config.extra_headers,
        "maxChunkChars": config.max_chunk_chars.unwrap_or(DEFAULT_CHUNK_CHARS),
        "overlapChunkChars": config.overlap_chunk_chars.unwrap_or(DEFAULT_OVERLAP_CHARS),
    });
    format!(
        "sha256:{:x}",
        Sha256::digest(signature.to_string().as_bytes())
    )
}

fn ensure_unique_page_stem(
    project_path: &str,
    page_path: &Path,
    page_id: &str,
) -> Result<(), PageEmbeddingError> {
    let wiki_root = fs::canonicalize(Path::new(project_path).join("wiki")).map_err(|err| {
        PageEmbeddingError::new(
            PageEmbeddingErrorKind::NotFound,
            format!("Failed to resolve project wiki directory: {err}"),
        )
    })?;
    let mut collisions = WalkDir::new(wiki_root)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .filter(|entry| {
            entry
                .path()
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
                && entry
                    .path()
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .is_some_and(|stem| stem.eq_ignore_ascii_case(page_id))
        })
        .filter_map(|entry| fs::canonicalize(entry.path()).ok())
        .filter(|path| path != page_path);
    if let Some(collision) = collisions.next() {
        return Err(PageEmbeddingError::new(
            PageEmbeddingErrorKind::Conflict,
            format!(
                "Cannot index this page because another wiki page has the same filename stem: {}",
                collision.to_string_lossy()
            ),
        ));
    }
    Ok(())
}

fn revision_path(project_path: &str, page_id: &str) -> PathBuf {
    let key = format!("{:x}", Sha256::digest(page_id.as_bytes()));
    Path::new(project_path)
        .join(REVISION_DIR)
        .join(format!("{key}.revision"))
}

pub(crate) fn load_revision(project_path: &str, page_id: &str) -> Option<String> {
    fs::read_to_string(revision_path(project_path, page_id))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub(crate) fn save_revision(
    project_path: &str,
    page_id: &str,
    revision: &str,
) -> Result<(), String> {
    let path = revision_path(project_path, page_id);
    let parent = path
        .parent()
        .ok_or_else(|| "Invalid embedding revision path".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|err| format!("Failed to create revision directory: {err}"))?;
    let temp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    fs::write(&temp, revision)
        .map_err(|err| format!("Failed to write embedding revision temp file: {err}"))?;
    if let Err(err) = fs::rename(&temp, &path) {
        // Windows does not replace an existing destination. The metadata is
        // only an optimization; restore the old valid file if replacement fails.
        if path.exists() {
            let previous = fs::read(&path).ok();
            fs::remove_file(&path).map_err(|remove_err| {
                format!("Failed to replace embedding revisions: {remove_err}")
            })?;
            if let Err(rename_err) = fs::rename(&temp, &path) {
                if let Some(previous) = previous {
                    let _ = fs::write(&path, previous);
                }
                return Err(format!(
                    "Failed to replace embedding revisions: {rename_err}"
                ));
            }
        } else {
            let _ = fs::remove_file(&temp);
            return Err(format!("Failed to save embedding revisions: {err}"));
        }
    }
    Ok(())
}

pub(crate) fn invalidate_page_revision(project_path: &str, page_id: &str) -> Result<(), String> {
    match fs::remove_file(revision_path(project_path, page_id)) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("Failed to invalidate embedding revision: {err}")),
    }
}

fn resolve_wiki_markdown_path(
    project_path: &str,
    relative_path: &str,
) -> Result<(PathBuf, String), PageEmbeddingError> {
    let raw = relative_path.trim().replace('\\', "/");
    if raw.is_empty() {
        return Err(PageEmbeddingError::new(
            PageEmbeddingErrorKind::InvalidRequest,
            "path is required",
        ));
    }
    let relative = Path::new(&raw);
    if relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
        || relative.components().next() != Some(Component::Normal("wiki".as_ref()))
        || relative
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref()
            != Some("md")
    {
        return Err(PageEmbeddingError::new(
            PageEmbeddingErrorKind::InvalidRequest,
            "path must be a project-relative Markdown file under wiki/",
        ));
    }

    let project = fs::canonicalize(project_path).map_err(|err| {
        PageEmbeddingError::new(
            PageEmbeddingErrorKind::NotFound,
            format!("Failed to resolve project path: {err}"),
        )
    })?;
    let wiki = fs::canonicalize(project.join("wiki")).map_err(|err| {
        PageEmbeddingError::new(
            PageEmbeddingErrorKind::NotFound,
            format!("Failed to resolve project wiki directory: {err}"),
        )
    })?;
    let page = fs::canonicalize(project.join(relative)).map_err(|err| {
        PageEmbeddingError::new(
            PageEmbeddingErrorKind::NotFound,
            format!("Wiki page not found: {err}"),
        )
    })?;
    if !page.starts_with(&wiki)
        || !page.is_file()
        || !page
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
    {
        return Err(PageEmbeddingError::new(
            PageEmbeddingErrorKind::InvalidRequest,
            "path must resolve to a file inside the project wiki directory",
        ));
    }
    let normalized = page
        .strip_prefix(&project)
        .map_err(|_| {
            PageEmbeddingError::new(PageEmbeddingErrorKind::InvalidRequest, "Invalid page path")
        })?
        .to_string_lossy()
        .replace('\\', "/");
    Ok((page, normalized))
}

fn extract_title(content: &str, fallback: &str) -> String {
    let normalized = content.replace("\r\n", "\n");
    if let Some(frontmatter) = leading_frontmatter(&normalized) {
        for line in frontmatter.lines() {
            if let Some(value) = line.trim().strip_prefix("title:") {
                let title = value.trim().trim_matches(['\"', '\'']);
                if !title.is_empty() {
                    return title.to_string();
                }
            }
        }
    }
    normalized
        .lines()
        .find_map(|line| line.trim().strip_prefix("# ").map(str::trim))
        .filter(|title| !title.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn leading_frontmatter(content: &str) -> Option<&str> {
    let rest = content.strip_prefix("---\n")?;
    let (end, _) = find_frontmatter_close(rest)?;
    Some(&rest[..end])
}

fn strip_frontmatter(content: &str) -> &str {
    let Some(rest) = content.strip_prefix("---\n") else {
        return content;
    };
    let Some((end, close_len)) = find_frontmatter_close(rest) else {
        return content;
    };
    let after_fence = &rest[end + close_len..];
    after_fence.strip_prefix('\n').unwrap_or(after_fence)
}

fn find_frontmatter_close(rest: &str) -> Option<(usize, usize)> {
    let mut offset = 0usize;
    for line in rest.split_inclusive('\n') {
        if line.trim_end_matches(['\r', '\n']).trim() == "---" {
            return Some((offset, line.len()));
        }
        offset += line.len();
    }
    (rest.trim() == "---").then_some((0, rest.len()))
}

// The regular ingest pipeline uses src/lib/text-chunker.ts. Keep heading,
// frontmatter, fenced-block, table, overlap, and Unicode behavior aligned when
// changing either implementation.
fn chunk_markdown(content: &str, target_chars: usize, overlap_chars: usize) -> Vec<MarkdownChunk> {
    let normalized = content.replace("\r\n", "\n");
    let body = strip_frontmatter(&normalized);
    let mut chunks = Vec::new();
    let mut heading_stack: Vec<(usize, String)> = Vec::new();
    let mut heading_path = String::new();
    let mut section = String::new();

    let flush = |section: &mut String, heading_path: &str, chunks: &mut Vec<MarkdownChunk>| {
        let text = section.trim();
        if !text.is_empty() {
            for piece in split_preserving_atomic_blocks(text, target_chars, overlap_chars) {
                chunks.push(MarkdownChunk {
                    text: piece,
                    heading_path: heading_path.to_string(),
                });
            }
        }
        section.clear();
    };

    let mut open_fence: Option<(char, usize)> = None;
    for line in body.lines() {
        let trimmed = line.trim_start();
        if let Some((marker, width)) = fence_marker(trimmed) {
            match open_fence {
                None => open_fence = Some((marker, width)),
                Some((open, open_width)) if open == marker && width >= open_width => {
                    open_fence = None
                }
                Some(_) => {}
            }
        }
        let heading = if open_fence.is_none() {
            parse_heading(line)
        } else {
            None
        };
        if let Some((level, title)) = heading {
            flush(&mut section, &heading_path, &mut chunks);
            heading_stack.retain(|(existing, _)| *existing < level);
            heading_stack.push((level, title.to_string()));
            heading_path = heading_stack
                .iter()
                .map(|(level, title)| format!("{} {}", "#".repeat(*level), title))
                .collect::<Vec<_>>()
                .join(" > ");
        }
        if !section.is_empty() {
            section.push('\n');
        }
        section.push_str(line);
    }
    flush(&mut section, &heading_path, &mut chunks);
    chunks
}

fn split_preserving_atomic_blocks(
    text: &str,
    target_chars: usize,
    overlap_chars: usize,
) -> Vec<String> {
    let lines = text.lines().collect::<Vec<_>>();
    let mut chunks = Vec::new();
    let mut normal = Vec::new();
    let mut index = 0usize;

    let flush_normal = |normal: &mut Vec<&str>, chunks: &mut Vec<String>| {
        if normal.is_empty() {
            return;
        }
        chunks.extend(split_with_overlap(
            &normal.join("\n"),
            target_chars,
            overlap_chars,
        ));
        normal.clear();
    };

    while index < lines.len() {
        if let Some((marker, width)) = fence_marker(lines[index]) {
            flush_normal(&mut normal, &mut chunks);
            let start = index;
            index += 1;
            while index < lines.len() {
                let is_close =
                    fence_marker(lines[index]).is_some_and(|(candidate, candidate_width)| {
                        candidate == marker && candidate_width >= width
                    });
                index += 1;
                if is_close {
                    break;
                }
            }
            push_atomic_chunk(&mut chunks, lines[start..index].join("\n"));
            continue;
        }

        if lines[index].trim_start().starts_with('|') {
            flush_normal(&mut normal, &mut chunks);
            let start = index;
            while index < lines.len() && lines[index].trim_start().starts_with('|') {
                index += 1;
            }
            push_atomic_chunk(&mut chunks, lines[start..index].join("\n"));
            continue;
        }

        normal.push(lines[index]);
        index += 1;
    }
    flush_normal(&mut normal, &mut chunks);
    chunks
        .into_iter()
        .filter(|chunk| !chunk.trim().is_empty())
        .collect()
}

fn push_atomic_chunk(chunks: &mut Vec<String>, chunk: String) {
    if chunk.chars().count() <= MAX_CHUNK_CHARS {
        chunks.push(chunk);
    } else {
        // Preserve ordinary code/table blocks as a unit, but never send an
        // unbounded payload to an embedding provider.
        chunks.extend(split_with_overlap(
            &chunk,
            MAX_CHUNK_CHARS,
            DEFAULT_OVERLAP_CHARS,
        ));
    }
}

fn fence_marker(line: &str) -> Option<(char, usize)> {
    let trimmed = line.trim_start();
    let marker = trimmed.chars().next()?;
    if marker != '`' && marker != '~' {
        return None;
    }
    let width = trimmed.chars().take_while(|ch| *ch == marker).count();
    (width >= 3).then_some((marker, width))
}

fn parse_heading(line: &str) -> Option<(usize, &str)> {
    let hashes = line.chars().take_while(|ch| *ch == '#').count();
    if !(1..=6).contains(&hashes) || line.chars().nth(hashes) != Some(' ') {
        return None;
    }
    let title = line[hashes + 1..].trim();
    (!title.is_empty()).then_some((hashes, title))
}

fn split_with_overlap(text: &str, target_chars: usize, overlap_chars: usize) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= target_chars {
        return vec![text.to_string()];
    }
    let mut out = Vec::new();
    let mut start = 0usize;
    while start < chars.len() {
        let hard_end = (start + target_chars).min(chars.len());
        let end = if hard_end < chars.len() {
            (start + target_chars / 2..hard_end)
                .rev()
                .find(|index| {
                    chars[*index].is_whitespace()
                        || matches!(
                            chars[*index],
                            '。' | '！' | '？' | '.' | '!' | '?' | ';' | '；'
                        )
                })
                .map(|index| index + 1)
                .unwrap_or(hard_end)
        } else {
            hard_end
        };
        let piece: String = chars[start..end].iter().collect();
        if !piece.trim().is_empty() {
            out.push(piece.trim().to_string());
        }
        if end == chars.len() {
            break;
        }
        start = end.saturating_sub(overlap_chars).max(start + 1);
    }
    out
}

fn enrich_chunk(title: &str, chunk: &MarkdownChunk) -> String {
    [title.trim(), chunk.heading_path.trim(), chunk.text.trim()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use uuid::Uuid;

    fn project() -> PathBuf {
        let root = std::env::temp_dir().join(format!("llm-wiki-page-embed-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("wiki/nested")).unwrap();
        root
    }

    fn embedding_config(model: &str) -> SearchEmbeddingConfig {
        SearchEmbeddingConfig {
            enabled: true,
            endpoint: "https://example.com/v1/embeddings".to_string(),
            api_key: "secret".to_string(),
            model: model.to_string(),
            output_dimensionality: Some(768.0),
            extra_headers: Some(BTreeMap::from([("X-Route".to_string(), "a".to_string())])),
            max_chunk_chars: Some(1_000),
            overlap_chunk_chars: Some(200),
        }
    }

    #[test]
    fn path_guard_accepts_only_existing_markdown_inside_wiki() {
        let root = project();
        fs::write(root.join("wiki/nested/page.md"), "# Page").unwrap();
        fs::write(root.join("outside.md"), "# Outside").unwrap();

        let (_, relative) =
            resolve_wiki_markdown_path(root.to_str().unwrap(), "wiki\\nested/page.md").unwrap();
        assert_eq!(relative, "wiki/nested/page.md");
        assert!(resolve_wiki_markdown_path(root.to_str().unwrap(), "../outside.md").is_err());
        assert!(resolve_wiki_markdown_path(root.to_str().unwrap(), "outside.md").is_err());
        assert!(resolve_wiki_markdown_path(root.to_str().unwrap(), "wiki/missing.md").is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn chunker_strips_crlf_frontmatter_and_preserves_heading_context() {
        let input =
            "---\r\ntitle: 测试页面\r\n---\r\n# 第一章\r\n\r\n内容一。\r\n## 第二节\r\n内容二。";
        let chunks = chunk_markdown(input, 64, 8);
        assert_eq!(extract_title(input, "fallback"), "测试页面");
        assert!(chunks.iter().all(|chunk| !chunk.text.contains("title:")));
        assert!(chunks
            .iter()
            .any(|chunk| chunk.heading_path.contains("# 第一章")));
        assert!(chunks
            .iter()
            .any(|chunk| chunk.heading_path.contains("## 第二节")));
    }

    #[test]
    fn cjk_hard_split_uses_character_boundaries_and_overlap() {
        let text = "中文内容用于验证字符边界不会发生截断异常。".repeat(20);
        let chunks = split_with_overlap(&text, 64, 8);
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|chunk| chunk.chars().count() <= 64));
        for pair in chunks.windows(2) {
            let suffix: String = pair[0]
                .chars()
                .rev()
                .take(8)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            assert!(pair[1].starts_with(&suffix));
        }
    }

    #[test]
    fn fingerprint_changes_with_embedding_semantics_but_not_api_key_rotation() {
        let base = embedding_config("model-a");
        let mut changed_model = base.clone();
        changed_model.model = "model-b".to_string();
        let mut rotated_key = base.clone();
        rotated_key.api_key = "rotated".to_string();
        assert_ne!(
            embedding_fingerprint("sha256:content", &base),
            embedding_fingerprint("sha256:content", &changed_model)
        );
        assert_eq!(
            embedding_fingerprint("sha256:content", &base),
            embedding_fingerprint("sha256:content", &rotated_key)
        );
    }

    #[test]
    fn frontmatter_close_requires_a_standalone_fence() {
        let input = "---\ntitle: Kept\nnote: ---not-a-fence\n---\n# Body";
        assert_eq!(extract_title(input, "fallback"), "Kept");
        assert_eq!(strip_frontmatter(input), "# Body");
    }

    #[test]
    fn duplicate_stems_in_different_wiki_folders_are_rejected() {
        let root = project();
        let first = root.join("wiki/nested/page.md");
        fs::write(&first, "# First").unwrap();
        fs::create_dir_all(root.join("wiki/other")).unwrap();
        fs::write(root.join("wiki/other/page.md"), "# Second").unwrap();
        let error = ensure_unique_page_stem(root.to_str().unwrap(), &first, "page").unwrap_err();
        assert_eq!(error.kind, PageEmbeddingErrorKind::Conflict);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn chunker_keeps_fenced_code_and_tables_atomic() {
        let code = format!("```rust\n{}\n```", "let value = 1;\n".repeat(12));
        let table = format!(
            "| Name | Value |\n| --- | --- |\n{}",
            "| A | B |\n".repeat(12)
        );
        let input = format!("# Page\n\nBefore text.\n\n{code}\n\n{table}\n\nAfter text.");

        let chunks = chunk_markdown(&input, 64, 8);

        assert!(chunks.iter().any(|chunk| chunk.text.trim() == code.trim()));
        assert!(chunks.iter().any(|chunk| chunk.text.trim() == table.trim()));
        assert_eq!(
            chunks
                .iter()
                .filter(|chunk| chunk.text.contains("```rust"))
                .count(),
            1
        );
        assert_eq!(
            chunks
                .iter()
                .filter(|chunk| chunk.text.contains("| Name | Value |"))
                .count(),
            1
        );
    }

    #[test]
    fn oversized_atomic_blocks_respect_the_hard_provider_limit() {
        let input = format!("```text\n{}\n", "x".repeat(MAX_CHUNK_CHARS + 500));
        let chunks = chunk_markdown(&input, 1_000, 200);

        assert!(chunks.len() > 1);
        assert!(chunks
            .iter()
            .all(|chunk| chunk.text.chars().count() <= MAX_CHUNK_CHARS));
    }

    #[test]
    fn revision_metadata_is_per_page_and_invalidates_without_rewriting_other_pages() {
        let root = project();
        save_revision(root.to_str().unwrap(), "current", "sha256:current").unwrap();
        save_revision(root.to_str().unwrap(), "other", "sha256:other").unwrap();

        assert_eq!(
            load_revision(root.to_str().unwrap(), "current").as_deref(),
            Some("sha256:current")
        );
        invalidate_page_revision(root.to_str().unwrap(), "current").unwrap();
        assert_eq!(load_revision(root.to_str().unwrap(), "current"), None);
        assert_eq!(
            load_revision(root.to_str().unwrap(), "other").as_deref(),
            Some("sha256:other")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn inconsistent_provider_dimensions_are_rejected_before_storage() {
        let chunk = MarkdownChunk {
            text: "content".to_string(),
            heading_path: String::new(),
        };
        let rows = vec![
            chunk_row(0, &chunk, vec![1.0, 2.0]),
            chunk_row(1, &chunk, vec![1.0]),
        ];

        let error = validate_embedding_rows(&rows).unwrap_err();
        assert_eq!(error.kind, PageEmbeddingErrorKind::Provider);
    }
}
