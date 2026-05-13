//! Image extraction from PDF / PPTX / DOCX (Phase 1 of the multimodal
//! pipeline; see plans/multimodal-images.md).
//!
//! NO LLM calls happen in this module. Output is the raw extracted
//! images as PNG-encoded base64 strings, ready for either:
//!   - the vision-caption helper (Phase 3) which sends them to a VLM
//!   - direct write-to-disk in `raw/assets/<source-slug>/`
//!
//! This module is intentionally separate from `fs.rs` (which already
//! has its own pdfium binding lifecycle for text extraction). PDF
//! image extraction reuses the same global `Pdfium` instance via the
//! `pdfium()` helper exposed by `fs.rs`.
//!
//! Outputs are deterministic for a given input file (same image
//! ordering, same `index` per image), so the dedup cache in Phase 3
//! can key purely on the SHA-256 of `data_base64`.

use std::fs::File;
use std::io::Read;
use std::path::Path;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::Serialize;
use sha2::{Digest, Sha256};

/// Filter knobs. The defaults mirror what's documented in
/// plans/multimodal-images.md; callers (the TS layer wiring this up)
/// will eventually surface them in Settings.
#[derive(Debug, Clone)]
pub struct ExtractOptions {
    /// Skip images smaller than this on EITHER axis. 100×100 catches
    /// the vast majority of icons / logos / page-corner decorations
    /// without dropping legitimate small chart insets.
    pub min_width: u32,
    pub min_height: u32,
    /// Hard cap on the number of images returned per document. A
    /// pathological 5000-image PDF would otherwise blow up memory
    /// (each image base64'd is ~MB-scale) AND blow up downstream VLM
    /// cost during Phase 3.
    pub max_images: usize,
}

impl Default for ExtractOptions {
    fn default() -> Self {
        Self {
            min_width: 100,
            min_height: 100,
            max_images: 500,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedImage {
    /// 1-based index in document order. Stable across re-extractions.
    /// Used as the filename suffix when the caller writes images to
    /// `raw/assets/<slug>/img-<index>.<ext>`.
    pub index: u32,
    /// MIME type ("image/png" / "image/jpeg" / etc.). PNG for any
    /// image we re-encode (PDFs always); pass-through for office docs
    /// where the original bytes are already in a web-friendly format.
    pub mime_type: String,
    /// 1-based page number for PDFs / 1-based slide number for PPTX.
    /// `None` for DOCX (which doesn't have a per-image page concept
    /// at extraction time without parsing document.xml position
    /// markers, which is more work than this phase needs).
    pub page: Option<u32>,
    pub width: u32,
    pub height: u32,
    /// Image bytes, base64-encoded. JSON IPC can't carry raw binary.
    pub data_base64: String,
    /// SHA-256 hex of the *encoded* bytes (same encoding as
    /// `data_base64` decodes to). Used by the Phase 3 caption cache
    /// to dedupe identical images across files.
    pub sha256: String,
}

// ── PDF (pdfium) ────────────────────────────────────────────────────────

/// Combined PDF text + image extraction in a single pdfium session.
///
/// Output is a markdown string with `## Page N` headers, the page's
/// extracted text, and `![](url)` references to images embedded on
/// that page — interleaved per-page so the document reads top-to-
/// bottom the way the source did.
///
/// When `media_dest_dir` is `Some`, every embedded raster image
/// passing the size filter is written to that directory as
/// `img-<N>.png` (1-based across the whole document) and referenced
/// in the markdown via `media_url_prefix + "/img-<N>.png"`. Pass an
/// absolute path as the prefix when you want the markdown to render
/// regardless of where the file is opened (this is what the raw-
/// source preview wants — see `extract_pdf_text` in fs.rs).
///
/// When `media_dest_dir` is `None`, image objects are skipped
/// entirely and the output is text + page headers only — useful for
/// PDFs outside the project's `raw/sources/` layout where there's no
/// stable place to land the image files.
///
/// Holds the global pdfium lock for its full duration. Callers MUST
/// NOT acquire the lock themselves before calling this (would
/// deadlock — `std::sync::Mutex` is non-reentrant).
pub fn extract_pdf_markdown(
    path: &str,
    media_dest_dir: Option<&Path>,
    media_url_prefix: &str,
    options: &ExtractOptions,
) -> Result<String, String> {
    use pdfium_render::prelude::*;

    let _guard = crate::commands::fs::lock_pdfium();
    let pdfium = crate::commands::fs::pdfium()?;
    let doc = pdfium
        .load_pdf_from_file(path, None)
        .map_err(|e| match e {
            PdfiumError::PdfiumLibraryInternalError(
                PdfiumInternalError::PasswordError,
            ) => format!("PDF is password-protected and cannot be read: '{path}'"),
            _ => format!("Failed to open PDF '{path}': {e}"),
        })?;

    let mut out = String::new();
    let mut idx: u32 = 0;
    let mut total_saved: u32 = 0;
    // Strip a single trailing slash from the prefix so we can always
    // emit `prefix + "/" + name` without producing `path//name`.
    let prefix = media_url_prefix.trim_end_matches('/');

    let page_count = doc.pages().len();
    if media_dest_dir.is_some() {
        eprintln!(
            "[extract_pdf_markdown] '{path}': {page_count} page(s), images→{:?}",
            media_dest_dir.map(|d| d.display().to_string())
        );
    }

    for (page_idx, page) in doc.pages().iter().enumerate() {
        let page_num = page_idx + 1;
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(&format!("## Page {page_num}\n\n"));

        let page_text = page
            .text()
            .map_err(|e| {
                format!("Page {page_num} text extraction failed in '{path}': {e}")
            })?;
        out.push_str(&page_text.all());
        // Single trailing newline so the next block starts on its own
        // line; the `\n\n` separator before the next `## Page` heading
        // gets prepended by the loop entry above.
        out.push('\n');

        // Skip image extraction when the caller didn't supply a
        // destination — no point burning pdfium cycles to throw the
        // pixels away.
        let dest_dir = match media_dest_dir {
            Some(d) => d,
            None => continue,
        };

        let mut page_image_md: Vec<String> = Vec::new();
        for object in page.objects().iter() {
            let image = match object.as_image_object() {
                Some(img) => img,
                None => continue,
            };
            let dyn_img = match image.get_raw_image() {
                Ok(b) => b,
                Err(e) => {
                    eprintln!(
                        "[extract_pdf_markdown] page {page_num} image read failed: {e}"
                    );
                    continue;
                }
            };
            let width = dyn_img.width();
            let height = dyn_img.height();
            if width < options.min_width || height < options.min_height {
                continue;
            }
            let mut png_bytes: Vec<u8> = Vec::new();
            if let Err(e) = dyn_img.write_to(
                &mut std::io::Cursor::new(&mut png_bytes),
                image::ImageFormat::Png,
            ) {
                eprintln!(
                    "[extract_pdf_markdown] page {page_num} PNG encode failed: {e}"
                );
                continue;
            }
            idx += 1;
            let file_name = format!("img-{idx}.png");
            // `dest_dir_relative_to` is unused here (we don't need a
            // rel_path return — the markdown uses media_url_prefix);
            // pass dest_dir for both args so save_one_image's
            // strip_prefix is a no-op.
            if let Err(e) = save_one_image(&png_bytes, dest_dir, dest_dir, &file_name) {
                eprintln!(
                    "[extract_pdf_markdown] page {page_num} save failed: {e}"
                );
                continue;
            }
            total_saved += 1;
            // Empty alt-text on purpose: the JS caption pipeline
            // fills factual captions later when multimodal captioning
            // is enabled. A placeholder like "image" or the file name
            // only adds noise to the LLM and to screen readers.
            page_image_md.push(format!("![]({prefix}/{file_name})"));
            if total_saved as usize >= options.max_images {
                eprintln!(
                    "[extract_pdf_markdown] reached max_images={} cap; skipped rest",
                    options.max_images
                );
                break;
            }
        }
        if !page_image_md.is_empty() {
            out.push('\n');
            for img_md in &page_image_md {
                out.push_str(img_md);
                out.push('\n');
            }
        }
        if total_saved as usize >= options.max_images {
            break;
        }
    }

    if media_dest_dir.is_some() {
        eprintln!(
            "[extract_pdf_markdown] '{path}' DONE — pages={page_count}, saved={total_saved}"
        );
    }

    Ok(out)
}

/// Iterate every PDF page, extract every embedded raster image, and
/// re-encode each to PNG. Vector content (paths, glyph outlines) is
/// NOT extracted here — that's a Phase 1.5 follow-up if needed (would
/// involve rendering the entire page to a bitmap as a fallback).
pub fn extract_pdf_images(
    path: &str,
    options: &ExtractOptions,
) -> Result<Vec<ExtractedImage>, String> {
    use pdfium_render::prelude::*;

    // Hold the global PDFium lock for the entire call. The C library
    // is NOT safe for concurrent access — see `lock_pdfium` in fs.rs
    // for the full rationale. Held for the whole document lifetime so
    // page iteration doesn't race a concurrent `load_pdf_from_file`
    // on a different worker thread.
    let _guard = crate::commands::fs::lock_pdfium();
    let pdfium = crate::commands::fs::pdfium()?;
    let doc = pdfium
        .load_pdf_from_file(path, None)
        .map_err(|e| format!("Failed to open PDF '{path}': {e}"))?;

    let mut out: Vec<ExtractedImage> = Vec::new();
    let mut idx: u32 = 0;

    'pages: for (page_idx, page) in doc.pages().iter().enumerate() {
        for object in page.objects().iter() {
            // Only image objects. Path / text / shading / form / etc.
            // are all skipped — we don't try to rasterize vector charts
            // in this phase.
            let image = match object.as_image_object() {
                Some(img) => img,
                None => continue,
            };

            // get_raw_image returns an `image::DynamicImage`. PDFium
            // can fail per-image on a corrupt embed; we log + skip
            // rather than aborting the whole document.
            let dyn_img = match image.get_raw_image() {
                Ok(b) => b,
                Err(e) => {
                    eprintln!(
                        "[extract_pdf_images] page {} image read failed: {e}",
                        page_idx + 1
                    );
                    continue;
                }
            };

            let width = dyn_img.width();
            let height = dyn_img.height();
            if width < options.min_width || height < options.min_height {
                continue;
            }

            // Re-encode to PNG. We don't try to preserve the source
            // codec — PDFium often hands us raw RGBA, and even when
            // the embedded form was JPEG, decode → re-encode is fine
            // for the kind of resolutions inside PDFs.
            let mut png_bytes: Vec<u8> = Vec::new();
            if let Err(e) = dyn_img.write_to(
                &mut std::io::Cursor::new(&mut png_bytes),
                image::ImageFormat::Png,
            ) {
                eprintln!(
                    "[extract_pdf_images] page {} PNG encode failed: {e}",
                    page_idx + 1
                );
                continue;
            }

            idx += 1;
            let data_base64 = B64.encode(&png_bytes);
            let sha256 = sha256_hex(&png_bytes);

            out.push(ExtractedImage {
                index: idx,
                mime_type: "image/png".to_string(),
                page: Some((page_idx + 1) as u32),
                width,
                height,
                data_base64,
                sha256,
            });

            if out.len() >= options.max_images {
                eprintln!(
                    "[extract_pdf_images] reached max_images={} cap; remaining images skipped",
                    options.max_images
                );
                break 'pages;
            }
        }
    }

    Ok(out)
}

// ── PPTX / DOCX (zip) ──────────────────────────────────────────────────

/// Office Open XML formats (PPTX, DOCX) embed images verbatim under
/// `<root>/media/`. We don't parse the surrounding XML to figure out
/// which slide / paragraph an image lives in — that's more work than
/// this phase needs. PPTX gets a slide number heuristic via the
/// reference graph (`slide<N>.xml.rels` files reference `media/...`),
/// but for v1 we just pass `page: None` for DOCX and a best-effort
/// slide number for PPTX.
pub fn extract_office_images(
    path: &str,
    options: &ExtractOptions,
) -> Result<Vec<ExtractedImage>, String> {
    let file = File::open(path).map_err(|e| format!("Failed to open '{path}': {e}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("Failed to read zip '{path}': {e}"))?;

    // Detect whether this is a PPTX or DOCX/etc. by looking for the
    // canonical xml entry. PPTX has presentation.xml; DOCX has
    // document.xml. Only PPTX gets the slide-number lookup.
    let is_pptx = archive
        .file_names()
        .any(|n| n == "ppt/presentation.xml" || n.starts_with("ppt/slides/slide"));

    // Build a map of media_filename -> Option<slide_number>. For
    // PPTX, scan each slide<N>.xml.rels for media references. For
    // DOCX, no per-image page info — leave map empty / None.
    let media_to_slide = if is_pptx {
        build_pptx_media_slide_map(&mut archive)
    } else {
        std::collections::HashMap::new()
    };

    // List media entries up front so we can iterate by_index in a
    // stable order (file_names order is consistent within a single
    // archive). `by_index` is the zip crate's recommended pattern
    // for iteration since `by_name` re-walks the central directory
    // on every call.
    let media_indices: Vec<usize> = (0..archive.len())
        .filter(|i| {
            archive
                .by_index_raw(*i)
                .ok()
                .map(|f| is_media_path(f.name()))
                .unwrap_or(false)
        })
        .collect();

    let mut out: Vec<ExtractedImage> = Vec::new();
    let mut idx: u32 = 0;

    for archive_idx in media_indices {
        let mut entry = match archive.by_index(archive_idx) {
            Ok(e) => e,
            Err(e) => {
                eprintln!("[extract_office_images] zip entry {archive_idx} read failed: {e}");
                continue;
            }
        };

        let entry_name = entry.name().to_string();
        let mime_type = guess_mime_from_name(&entry_name);
        if mime_type.is_none() {
            // Unknown extension (svg / emf / wmf etc.) — skip rather
            // than try to handle vector formats in this phase.
            continue;
        }
        let mime_type = mime_type.unwrap();

        let mut bytes = Vec::with_capacity(entry.size() as usize);
        if let Err(e) = entry.read_to_end(&mut bytes) {
            eprintln!("[extract_office_images] read '{entry_name}' failed: {e}");
            continue;
        }

        // We need width/height to apply the size filter. Decoding via
        // the `image` crate is the safest cross-format path; it
        // recognizes PNG/JPEG/GIF/WEBP/BMP without re-encoding.
        let (width, height) = match image::load_from_memory(&bytes) {
            Ok(img) => (img.width(), img.height()),
            Err(e) => {
                eprintln!("[extract_office_images] decode '{entry_name}' failed: {e}");
                continue;
            }
        };
        if width < options.min_width || height < options.min_height {
            continue;
        }

        idx += 1;
        let data_base64 = B64.encode(&bytes);
        let sha256 = sha256_hex(&bytes);
        let page = media_to_slide.get(&entry_name).copied().flatten();

        out.push(ExtractedImage {
            index: idx,
            mime_type,
            page,
            width,
            height,
            data_base64,
            sha256,
        });

        if out.len() >= options.max_images {
            eprintln!(
                "[extract_office_images] reached max_images={} cap; remaining skipped",
                options.max_images
            );
            break;
        }
    }

    Ok(out)
}

// ── Helpers ─────────────────────────────────────────────────────────────

fn is_media_path(name: &str) -> bool {
    // PPTX: ppt/media/...    DOCX: word/media/...    XLSX: xl/media/...
    let lower = name.to_ascii_lowercase();
    lower.starts_with("ppt/media/")
        || lower.starts_with("word/media/")
        || lower.starts_with("xl/media/")
}

fn guess_mime_from_name(name: &str) -> Option<String> {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())?
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => Some("image/png".to_string()),
        "jpg" | "jpeg" => Some("image/jpeg".to_string()),
        "gif" => Some("image/gif".to_string()),
        "webp" => Some("image/webp".to_string()),
        "bmp" => Some("image/bmp".to_string()),
        // Vector formats explicitly skipped — we don't have a
        // rasterizer wired up in this phase.
        _ => None,
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    hex_encode(&digest)
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

/// Walk every `ppt/slides/slide<N>.xml.rels` file and record which
/// `ppt/media/*` files each slide references. Returns a flat map
/// `media_path -> Some(slide_number)`. If a media file isn't
/// referenced from any slide (rare; usually unused theme assets),
/// it's absent from the map and gets `None` at the call site.
fn build_pptx_media_slide_map(
    archive: &mut zip::ZipArchive<File>,
) -> std::collections::HashMap<String, Option<u32>> {
    use std::collections::HashMap;
    let mut out: HashMap<String, Option<u32>> = HashMap::new();

    // Collect rels paths first so we don't hold an active `archive`
    // borrow while reading. The clone is cheap (just file names).
    let rels_paths: Vec<String> = archive
        .file_names()
        .filter(|n| {
            // ppt/slides/_rels/slide<N>.xml.rels
            n.starts_with("ppt/slides/_rels/slide") && n.ends_with(".xml.rels")
        })
        .map(String::from)
        .collect();

    for rels_path in rels_paths {
        // Slide number is the digits between "slide" and ".xml.rels".
        let slide_num: Option<u32> = rels_path
            .strip_prefix("ppt/slides/_rels/slide")
            .and_then(|s| s.strip_suffix(".xml.rels"))
            .and_then(|s| s.parse().ok());

        let mut entry = match archive.by_name(&rels_path) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let mut xml = String::new();
        if entry.read_to_string(&mut xml).is_err() {
            continue;
        }

        // Naive extraction: rels XML has Target="../media/imageN.png"
        // attributes for image relationships. We don't bother with a
        // full XML parser — a substring scan is plenty for this.
        let mut search_from = 0;
        while let Some(pos) = xml[search_from..].find("Target=\"") {
            let start = search_from + pos + "Target=\"".len();
            let end = match xml[start..].find('"') {
                Some(e) => start + e,
                None => break,
            };
            let target = &xml[start..end];
            search_from = end + 1;

            // Targets are relative to the slide's _rels folder, e.g.
            // "../media/image3.png" → "ppt/media/image3.png".
            if let Some(stripped) = target.strip_prefix("../") {
                let canonical = format!("ppt/{stripped}");
                if is_media_path(&canonical) {
                    out.insert(canonical, slide_num);
                }
            }
        }
    }

    out
}

// ── Extract-and-save: write to disk, skip the base64 round-trip ────────
//
// The base64-returning commands above are useful for future
// captioning paths that need bytes in-memory. The ingest pipeline
// just wants to land images on disk and reference them from
// markdown — the round-trip via JS is wasteful (5 MB image → 6.7 MB
// base64 string → JS allocates → JS calls back to Rust → decode →
// write). The functions below short-circuit by writing directly.

/// Metadata for an image that's already been written to disk.
/// Mirrors `ExtractedImage` but swaps `data_base64` for `rel_path` —
/// the path the caller can embed in markdown (`![alt](rel_path)`).
///
/// `rename_all = "camelCase"` is REQUIRED, not cosmetic. The TS layer
/// validates the IPC payload by exact field names (`relPath`,
/// `absPath`, `mimeType`) — without this attribute serde would emit
/// `rel_path`/`abs_path`/`mime_type` and the validator drops every
/// item, returning `[]` even when extraction succeeded and saved
/// files to disk. Tauri's IPC auto-camelCase only applies to
/// COMMAND PARAMETER names, never to serialized return values.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedImage {
    pub index: u32,
    pub mime_type: String,
    pub page: Option<u32>,
    pub width: u32,
    pub height: u32,
    /// Path of the written file, relative to `dest_dir_relative_to`.
    /// E.g. when `dest_dir` is `<project>/raw/assets/foo` and
    /// `dest_dir_relative_to` is `<project>`, this is
    /// `raw/assets/foo/img-1.png`. The caller-provided base lets us
    /// generate paths that are stable regardless of wiki page depth.
    pub rel_path: String,
    /// Absolute path on disk — the chat / file-preview UI uses this
    /// (via `convertFileSrc`) to actually load the image.
    pub abs_path: String,
    pub sha256: String,
}

fn save_one_image(
    bytes: &[u8],
    dest_dir: &Path,
    dest_dir_relative_to: &Path,
    file_name: &str,
) -> Result<(String, String), String> {
    if !dest_dir.exists() {
        std::fs::create_dir_all(dest_dir)
            .map_err(|e| format!("create_dir_all '{}': {e}", dest_dir.display()))?;
    }
    let abs = dest_dir.join(file_name);
    std::fs::write(&abs, bytes).map_err(|e| format!("write '{}': {e}", abs.display()))?;

    let rel = abs
        .strip_prefix(dest_dir_relative_to)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| file_name.to_string());
    Ok((rel, abs.to_string_lossy().to_string()))
}

fn ext_for_mime(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        _ => "bin",
    }
}

/// PDF: extract every embedded image AND write each to
/// `dest_dir / img-<index>.<ext>`. `rel_to` is the directory the
/// returned `rel_path` is anchored at (typically the wiki root).
/// PNG re-encoding is unconditional (pdfium hands us decoded bitmaps
/// regardless of source codec).
pub fn extract_and_save_pdf_images(
    path: &str,
    dest_dir: &Path,
    rel_to: &Path,
    options: &ExtractOptions,
) -> Result<Vec<SavedImage>, String> {
    use pdfium_render::prelude::*;

    // See `extract_pdf_images` for why this lock is mandatory.
    let _guard = crate::commands::fs::lock_pdfium();
    let pdfium = crate::commands::fs::pdfium()?;
    let doc = pdfium
        .load_pdf_from_file(path, None)
        .map_err(|e| format!("Failed to open PDF '{path}': {e}"))?;

    let mut out: Vec<SavedImage> = Vec::new();
    let mut idx: u32 = 0;
    // Diagnostic counters — when extraction returns empty, the user's
    // first question is "did the PDF actually have raster images?"
    // These let us answer it from logs without having to crack open
    // the PDF in a debugger.
    let mut total_objects: u32 = 0;
    let mut total_image_objects: u32 = 0;
    let mut filtered_too_small: u32 = 0;
    let mut filtered_decode_err: u32 = 0;
    let mut filtered_encode_err: u32 = 0;

    let page_count = doc.pages().len();
    eprintln!(
        "[extract_and_save_pdf_images] '{path}': {} page(s), filter=({}x{}) min, max={}",
        page_count, options.min_width, options.min_height, options.max_images
    );

    'pages: for (page_idx, page) in doc.pages().iter().enumerate() {
        for object in page.objects().iter() {
            total_objects += 1;
            let image = match object.as_image_object() {
                Some(img) => img,
                None => continue,
            };
            total_image_objects += 1;
            let dyn_img = match image.get_raw_image() {
                Ok(b) => b,
                Err(e) => {
                    filtered_decode_err += 1;
                    eprintln!(
                        "[extract_and_save_pdf_images] page {} image read failed: {e}",
                        page_idx + 1
                    );
                    continue;
                }
            };
            let width = dyn_img.width();
            let height = dyn_img.height();
            if width < options.min_width || height < options.min_height {
                filtered_too_small += 1;
                eprintln!(
                    "[extract_and_save_pdf_images] page {} image {}x{} < min ({}x{}) — skipped",
                    page_idx + 1, width, height, options.min_width, options.min_height
                );
                continue;
            }

            let mut png_bytes: Vec<u8> = Vec::new();
            if let Err(e) = dyn_img.write_to(
                &mut std::io::Cursor::new(&mut png_bytes),
                image::ImageFormat::Png,
            ) {
                filtered_encode_err += 1;
                eprintln!(
                    "[extract_and_save_pdf_images] page {} PNG encode failed: {e}",
                    page_idx + 1
                );
                continue;
            }

            idx += 1;
            let file_name = format!("img-{idx}.png");
            let (rel_path, abs_path) = save_one_image(&png_bytes, dest_dir, rel_to, &file_name)?;
            let sha256 = sha256_hex(&png_bytes);

            out.push(SavedImage {
                index: idx,
                mime_type: "image/png".to_string(),
                page: Some((page_idx + 1) as u32),
                width,
                height,
                rel_path,
                abs_path,
                sha256,
            });

            if out.len() >= options.max_images {
                eprintln!(
                    "[extract_and_save_pdf_images] reached max_images={} cap; skipped rest",
                    options.max_images
                );
                break 'pages;
            }
        }
    }

    eprintln!(
        "[extract_and_save_pdf_images] '{path}' DONE — saved={}, total_objects={}, image_objects={}, too_small={}, decode_err={}, encode_err={}",
        out.len(), total_objects, total_image_objects, filtered_too_small, filtered_decode_err, filtered_encode_err,
    );

    Ok(out)
}

/// PPTX/DOCX: pull embedded images directly from the zip media/
/// directory and write each to `dest_dir`. Source format is
/// preserved (PNG stays PNG, JPEG stays JPEG) since pulling the raw
/// bytes is cheap and there's no compositing happening.
pub fn extract_and_save_office_images(
    path: &str,
    dest_dir: &Path,
    rel_to: &Path,
    options: &ExtractOptions,
) -> Result<Vec<SavedImage>, String> {
    let file = File::open(path).map_err(|e| format!("Failed to open '{path}': {e}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("Failed to read zip '{path}': {e}"))?;

    let is_pptx = archive
        .file_names()
        .any(|n| n == "ppt/presentation.xml" || n.starts_with("ppt/slides/slide"));
    let media_to_slide = if is_pptx {
        build_pptx_media_slide_map(&mut archive)
    } else {
        std::collections::HashMap::new()
    };

    let media_indices: Vec<usize> = (0..archive.len())
        .filter(|i| {
            archive
                .by_index_raw(*i)
                .ok()
                .map(|f| is_media_path(f.name()))
                .unwrap_or(false)
        })
        .collect();

    let mut out: Vec<SavedImage> = Vec::new();
    let mut idx: u32 = 0;

    for archive_idx in media_indices {
        let mut entry = match archive.by_index(archive_idx) {
            Ok(e) => e,
            Err(e) => {
                eprintln!("[extract_and_save_office_images] zip entry read failed: {e}");
                continue;
            }
        };
        let entry_name = entry.name().to_string();
        let mime_type = match guess_mime_from_name(&entry_name) {
            Some(m) => m,
            None => continue,
        };

        let mut bytes = Vec::with_capacity(entry.size() as usize);
        if let Err(e) = entry.read_to_end(&mut bytes) {
            eprintln!("[extract_and_save_office_images] read '{entry_name}' failed: {e}");
            continue;
        }

        let (width, height) = match image::load_from_memory(&bytes) {
            Ok(img) => (img.width(), img.height()),
            Err(e) => {
                eprintln!("[extract_and_save_office_images] decode '{entry_name}' failed: {e}");
                continue;
            }
        };
        if width < options.min_width || height < options.min_height {
            continue;
        }

        idx += 1;
        let ext = ext_for_mime(&mime_type);
        let file_name = format!("img-{idx}.{ext}");
        let (rel_path, abs_path) = save_one_image(&bytes, dest_dir, rel_to, &file_name)?;
        let sha256 = sha256_hex(&bytes);
        let page = media_to_slide.get(&entry_name).copied().flatten();

        out.push(SavedImage {
            index: idx,
            mime_type,
            page,
            width,
            height,
            rel_path,
            abs_path,
            sha256,
        });

        if out.len() >= options.max_images {
            eprintln!(
                "[extract_and_save_office_images] reached max_images={} cap; skipped rest",
                options.max_images
            );
            break;
        }
    }

    Ok(out)
}

// ── Tauri command bindings ─────────────────────────────────────────────

// Why every cmd below is `spawn_blocking`:
// PDFium FFI calls and zip+image-decode are all blocking. Running
// them inside an `async fn` body (as we did before this fix) kept
// them on a tokio worker thread, blocking other async tasks on
// that worker for the full duration of the extraction. `spawn_
// blocking` moves the work to tokio's blocking pool — that's the
// pool's contract. (Combined with the PDFium mutex inside
// `extract_pdf_images`, this also prevents the segfault that hit
// when two PDF extractions raced on different workers.)

#[tauri::command]
pub async fn extract_pdf_images_cmd(path: String) -> Result<Vec<ExtractedImage>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::panic_guard::run_guarded("extract_pdf_images", || {
            extract_pdf_images(&path, &ExtractOptions::default())
        })
    })
    .await
    .map_err(|e| format!("extract_pdf_images blocking task join error: {e}"))?
}

#[tauri::command]
pub async fn extract_office_images_cmd(path: String) -> Result<Vec<ExtractedImage>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::panic_guard::run_guarded("extract_office_images", || {
            extract_office_images(&path, &ExtractOptions::default())
        })
    })
    .await
    .map_err(|e| format!("extract_office_images blocking task join error: {e}"))?
}

#[tauri::command]
pub async fn extract_and_save_pdf_images_cmd(
    source_path: String,
    dest_dir: String,
    rel_to: String,
) -> Result<Vec<SavedImage>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::panic_guard::run_guarded("extract_and_save_pdf_images", || {
            extract_and_save_pdf_images(
                &source_path,
                Path::new(&dest_dir),
                Path::new(&rel_to),
                &ExtractOptions::default(),
            )
        })
    })
    .await
    .map_err(|e| format!("extract_and_save_pdf_images blocking task join error: {e}"))?
}

#[tauri::command]
pub async fn extract_and_save_office_images_cmd(
    source_path: String,
    dest_dir: String,
    rel_to: String,
) -> Result<Vec<SavedImage>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::panic_guard::run_guarded("extract_and_save_office_images", || {
            extract_and_save_office_images(
                &source_path,
                Path::new(&dest_dir),
                Path::new(&rel_to),
                &ExtractOptions::default(),
            )
        })
    })
    .await
    .map_err(|e| format!("extract_and_save_office_images blocking task join error: {e}"))?
}

// ── Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_media_path_recognizes_pptx_docx_xlsx() {
        assert!(is_media_path("ppt/media/image1.png"));
        assert!(is_media_path("word/media/image2.jpeg"));
        assert!(is_media_path("xl/media/image3.gif"));
        assert!(!is_media_path("ppt/slides/slide1.xml"));
        assert!(!is_media_path("word/document.xml"));
        assert!(!is_media_path("docProps/thumbnail.jpeg"));
    }

    #[test]
    fn guess_mime_from_name_covers_common_formats() {
        assert_eq!(
            guess_mime_from_name("ppt/media/image1.PNG"),
            Some("image/png".to_string())
        );
        assert_eq!(
            guess_mime_from_name("word/media/image2.jpeg"),
            Some("image/jpeg".to_string())
        );
        assert_eq!(
            guess_mime_from_name("ppt/media/image3.jpg"),
            Some("image/jpeg".to_string())
        );
        // Vector formats deliberately rejected — we don't rasterize
        // SVG/EMF/WMF in this phase, surfacing them as strings would
        // mislead the caption pipeline.
        assert_eq!(guess_mime_from_name("ppt/media/foo.svg"), None);
        assert_eq!(guess_mime_from_name("ppt/media/foo.emf"), None);
    }

    #[test]
    fn sha256_hex_is_deterministic_and_64_chars() {
        let h1 = sha256_hex(b"hello world");
        let h2 = sha256_hex(b"hello world");
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64);
        // Known SHA-256 of "hello world".
        assert_eq!(
            h1,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
    }

    #[test]
    fn extract_options_defaults_match_plan() {
        // Plan documents 100×100 / 500 as the v1 defaults. Pinning
        // these here so a casual change is visible.
        let o = ExtractOptions::default();
        assert_eq!(o.min_width, 100);
        assert_eq!(o.min_height, 100);
        assert_eq!(o.max_images, 500);
    }
}
