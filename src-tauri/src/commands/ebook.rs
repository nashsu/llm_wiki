//! Safe, cross-platform text extraction for ebook source files.
//!
//! The extractor returns one Markdown-shaped document so the existing ingest,
//! chunking, embedding, and preview pipelines do not need ebook-specific
//! branches. EPUB spine order is authoritative. MOBI support is intentionally
//! limited to DRM-free files accepted by the pure-Rust parser; encrypted Kindle
//! books are rejected instead of producing misleading partial text.

use std::fs;
use std::path::Path;

use epub::doc::EpubDoc;
use mobi::headers::Encryption;

const MAX_EBOOK_BYTES: u64 = 100 * 1024 * 1024;
const MAX_EPUB_ENTRIES: usize = 10_000;
const MAX_EPUB_EXPANDED_BYTES: u64 = 512 * 1024 * 1024;
const MAX_EPUB_COMPRESSION_RATIO: u64 = 200;
const MAX_EPUB_CHAPTER_BYTES: usize = 16 * 1024 * 1024;
const MAX_EXTRACTED_TEXT_BYTES: usize = 32 * 1024 * 1024;
const MAX_CHAPTERS: usize = 10_000;

pub fn extract_ebook_text(path: &str, extension: &str) -> Result<String, String> {
    validate_source_file(path)?;
    match extension {
        "epub" => extract_epub(path),
        "mobi" => extract_mobi(path),
        _ => Err(format!("Unsupported ebook format: .{extension}")),
    }
}

fn validate_source_file(path: &str) -> Result<(), String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Failed to inspect ebook '{}': {error}", path))?;
    if !metadata.is_file() {
        return Err(format!("Ebook path is not a file: '{path}'"));
    }
    if metadata.len() > MAX_EBOOK_BYTES {
        return Err(format!(
            "Ebook exceeds the {} MB extraction limit",
            MAX_EBOOK_BYTES / 1024 / 1024
        ));
    }
    Ok(())
}

fn validate_epub_archive(path: &str) -> Result<(), String> {
    let file =
        fs::File::open(path).map_err(|error| format!("Failed to open EPUB '{}': {error}", path))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|error| format!("Invalid EPUB ZIP container: {error}"))?;
    if archive.len() > MAX_EPUB_ENTRIES {
        return Err(format!(
            "EPUB contains too many archive entries ({} > {MAX_EPUB_ENTRIES})",
            archive.len()
        ));
    }

    let mut expanded = 0_u64;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("Failed to inspect EPUB entry {index}: {error}"))?;
        if entry.enclosed_name().is_none() {
            return Err(format!(
                "EPUB contains an unsafe archive path: {}",
                entry.name()
            ));
        }
        if is_epub_text_entry(entry.name()) && entry.size() > MAX_EPUB_CHAPTER_BYTES as u64 {
            return Err(format!(
                "EPUB text entry '{}' exceeds the {} MB safety limit",
                entry.name(),
                MAX_EPUB_CHAPTER_BYTES / 1024 / 1024
            ));
        }
        expanded = expanded.saturating_add(entry.size());
        if expanded > MAX_EPUB_EXPANDED_BYTES {
            return Err(format!(
                "EPUB expanded content exceeds the {} MB safety limit",
                MAX_EPUB_EXPANDED_BYTES / 1024 / 1024
            ));
        }
        let compressed = entry.compressed_size();
        if entry.size() > 1024 * 1024
            && compressed > 0
            && entry.size() / compressed > MAX_EPUB_COMPRESSION_RATIO
        {
            return Err(format!(
                "EPUB entry has an unsafe compression ratio: {}",
                entry.name()
            ));
        }
    }
    Ok(())
}

fn is_epub_text_entry(name: &str) -> bool {
    matches!(
        Path::new(name)
            .extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("html" | "htm" | "xhtml" | "xml")
    )
}

fn extract_epub(path: &str) -> Result<String, String> {
    validate_epub_archive(path)?;
    let mut document =
        EpubDoc::new(path).map_err(|error| format!("Failed to parse EPUB '{}': {error}", path))?;
    let title = document
        .mdata("title")
        .map(|item| item.value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| file_stem(path));
    let author = document
        .mdata("creator")
        .map(|item| item.value.trim().to_string());
    let language = document
        .mdata("language")
        .map(|item| item.value.trim().to_string());
    let publisher = document
        .mdata("publisher")
        .map(|item| item.value.trim().to_string());

    let mut output = ebook_header(
        &title,
        author.as_deref(),
        language.as_deref(),
        publisher.as_deref(),
        "epub",
    );
    let chapter_count = document.spine.len().min(MAX_CHAPTERS);
    let mut extracted_chapters = 0_usize;
    for index in 0..chapter_count {
        if !document.set_current_chapter(index) {
            continue;
        }
        let chapter_path = document
            .get_current_path()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| format!("chapter-{}", index + 1));
        let Some((bytes, mime)) = document.get_current() else {
            continue;
        };
        if !mime.contains("html") && !mime.contains("xml") {
            continue;
        }
        if bytes.len() > MAX_EPUB_CHAPTER_BYTES {
            return Err(format!(
                "EPUB chapter {} exceeds the {} MB safety limit",
                index + 1,
                MAX_EPUB_CHAPTER_BYTES / 1024 / 1024
            ));
        }
        let text = html_to_text(&bytes)?;
        if text.trim().is_empty() {
            continue;
        }
        let chapter_path = safe_heading_text(&chapter_path);
        push_bounded(
            &mut output,
            &format!(
                "\n\n## Chapter {} · {}\n\n{}",
                index + 1,
                chapter_path,
                text.trim()
            ),
        )?;
        extracted_chapters += 1;
    }

    if extracted_chapters == 0 {
        return Err("EPUB contains no extractable chapter text".to_string());
    }
    Ok(output)
}

fn extract_mobi(path: &str) -> Result<String, String> {
    let document = mobi::Mobi::from_path(path)
        .map_err(|error| format!("Failed to parse MOBI '{}': {error}", path))?;
    if document.encryption() != Encryption::No {
        return Err("Encrypted/DRM-protected MOBI files are not supported".to_string());
    }
    if document.metadata.palmdoc.text_length as usize > MAX_EXTRACTED_TEXT_BYTES {
        return Err(format!(
            "MOBI declares more than {} MB of text",
            MAX_EXTRACTED_TEXT_BYTES / 1024 / 1024
        ));
    }

    let title = document.title().trim().to_string();
    let title = if title.is_empty() {
        file_stem(path)
    } else {
        title
    };
    let author = document.author();
    let publisher = document.publisher();
    let language = Some(format!("{:?}", document.language()));
    let raw = document
        .content_as_string()
        .unwrap_or_else(|_| document.content_as_string_lossy());
    let text = if raw.contains('<') {
        html_to_text(raw.as_bytes())?
    } else {
        raw
    };
    if text.trim().is_empty() {
        return Err("MOBI contains no extractable text".to_string());
    }

    let mut output = ebook_header(
        &title,
        author.as_deref(),
        language.as_deref(),
        publisher.as_deref(),
        "mobi",
    );
    push_bounded(&mut output, &format!("\n\n{}", text.trim()))?;
    Ok(output)
}

fn ebook_header(
    title: &str,
    author: Option<&str>,
    language: Option<&str>,
    publisher: Option<&str>,
    format: &str,
) -> String {
    let mut output = format!("# {}\n\n", safe_inline_text(title, 500));
    output.push_str("## Book metadata\n\n");
    output.push_str(&format!("- Format: {}\n", format.to_uppercase()));
    if let Some(author) = non_empty(author) {
        output.push_str(&format!("- Author: {}\n", safe_inline_text(author, 1_000)));
    }
    if let Some(language) = non_empty(language) {
        output.push_str(&format!(
            "- Language: {}\n",
            safe_inline_text(language, 100)
        ));
    }
    if let Some(publisher) = non_empty(publisher) {
        output.push_str(&format!(
            "- Publisher: {}\n",
            safe_inline_text(publisher, 1_000)
        ));
    }
    output.push_str("\n## Contents");
    output
}

fn html_to_text(bytes: &[u8]) -> Result<String, String> {
    html2text::from_read(bytes, 120)
        .map(|text| text.replace("\r\n", "\n"))
        .map_err(|error| format!("Failed to convert ebook HTML to text: {error}"))
}

fn push_bounded(output: &mut String, value: &str) -> Result<(), String> {
    if output.len().saturating_add(value.len()) > MAX_EXTRACTED_TEXT_BYTES {
        return Err(format!(
            "Extracted ebook text exceeds the {} MB safety limit",
            MAX_EXTRACTED_TEXT_BYTES / 1024 / 1024
        ));
    }
    output.push_str(value);
    Ok(())
}

fn file_stem(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Untitled ebook")
        .to_string()
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn safe_heading_text(value: &str) -> String {
    safe_inline_text(value, 240)
}

fn safe_inline_text(value: &str, max_chars: usize) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .take(max_chars)
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn converts_html_without_executing_markup() {
        let text = html_to_text(b"<h1>Chapter</h1><script>alert(1)</script><p>Hello</p>").unwrap();
        assert!(text.contains("Chapter"));
        assert!(text.contains("Hello"));
        assert!(!text.contains("alert(1)"));
    }

    #[test]
    fn rejects_epub_archive_traversal_paths() {
        let path = std::env::temp_dir().join(format!("unsafe-{}.epub", uuid::Uuid::new_v4()));
        let file = fs::File::create(&path).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        archive
            .start_file("../outside.xhtml", zip::write::SimpleFileOptions::default())
            .unwrap();
        archive.write_all(b"<p>unsafe</p>").unwrap();
        archive.finish().unwrap();

        let error = validate_epub_archive(path.to_str().unwrap()).unwrap_err();
        assert!(error.contains("unsafe archive path"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn extracts_epub_metadata_and_spine_content() {
        let path = std::env::temp_dir().join(format!("book-{}.epub", uuid::Uuid::new_v4()));
        let file = fs::File::create(&path).unwrap();
        let mut archive = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        archive.start_file("mimetype", options).unwrap();
        archive.write_all(b"application/epub+zip").unwrap();
        archive
            .start_file("META-INF/container.xml", options)
            .unwrap();
        archive.write_all(br#"<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#).unwrap();
        archive.start_file("OEBPS/content.opf", options).unwrap();
        archive.write_all(br#"<?xml version="1.0"?><package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">test</dc:identifier><dc:title>Test Book</dc:title><dc:creator>Test Author</dc:creator><dc:language>en</dc:language></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>"#).unwrap();
        archive.start_file("OEBPS/chapter.xhtml", options).unwrap();
        archive.write_all(br#"<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>Opening</h1><p>Hello ebook.</p></body></html>"#).unwrap();
        archive.finish().unwrap();

        let output = extract_ebook_text(path.to_str().unwrap(), "epub").unwrap();
        assert!(output.contains("# Test Book"));
        assert!(output.contains("Author: Test Author"));
        assert!(output.contains("Opening"));
        assert!(output.contains("Hello ebook."));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn output_limit_is_enforced_before_append() {
        let mut output = "x".repeat(MAX_EXTRACTED_TEXT_BYTES);
        assert!(push_bounded(&mut output, "y").is_err());
        assert_eq!(output.len(), MAX_EXTRACTED_TEXT_BYTES);
    }

    #[test]
    fn metadata_is_single_line_and_bounded() {
        let value = format!("Book\r\nTitle {}", "x".repeat(600));
        let sanitized = safe_inline_text(&value, 20);
        assert_eq!(sanitized, "Book Title xxxxxxxx");
        assert!(!sanitized.contains('\n'));
    }

    #[test]
    fn identifies_epub_text_entries_case_insensitively() {
        assert!(is_epub_text_entry("OEBPS/chapter.XHTML"));
        assert!(is_epub_text_entry("META-INF/container.xml"));
        assert!(!is_epub_text_entry("OEBPS/images/cover.png"));
    }
}
