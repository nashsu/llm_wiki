use std::fs;
use std::io::Read as IoRead;
use std::path::Path;

use calamine::{Reader, open_workbook_auto, Data};

use crate::panic_guard::run_guarded;
use crate::types::wiki::FileNode;

/// Known binary formats that need special extraction
const OFFICE_EXTS: &[&str] = &["docx", "pptx", "xlsx", "odt", "ods", "odp"];
const IMAGE_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tiff", "tif", "avif", "heic", "heif", "svg",
];
const MEDIA_EXTS: &[&str] = &[
    "mp4", "webm", "mov", "avi", "mkv", "flv", "wmv", "m4v",
    "mp3", "wav", "ogg", "flac", "aac", "m4a", "wma",
];
const LEGACY_DOC_EXTS: &[&str] = &["doc", "xls", "ppt", "pages", "numbers", "key", "epub"];

#[tauri::command]
pub async fn read_file(path: String) -> Result<String, String> {
    // `spawn_blocking` is REQUIRED, not a perf nicety. The body does
    // synchronous PDF/Office text extraction (pdfium FFI, calamine,
    // zip + image decode) that can take 10s+ on big files. Running
    // that directly inside an `async fn` body would block the tokio
    // worker thread it's scheduled on, starving every other async
    // task on that worker (notably re-rendering the import progress
    // UI, which is what motivated the async conversion in the first
    // place). `spawn_blocking` moves the work to tokio's blocking
    // pool where blocking-for-seconds is the contract.
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("read_file", || {
            let p = Path::new(&path);
            let ext = p
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();

            if let Some(cached) = read_cache(p) {
                return Ok(cached);
            }

            match ext.as_str() {
                "pdf" => extract_pdf_text(&path),
                e if OFFICE_EXTS.contains(&e) => extract_office_text(&path, e),
                e if IMAGE_EXTS.contains(&e) => {
                    let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                    Ok(format!("[Image: {} ({:.1} KB)]", p.file_name().unwrap_or_default().to_string_lossy(), size as f64 / 1024.0))
                }
                e if MEDIA_EXTS.contains(&e) => {
                    let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                    Ok(format!("[Media: {} ({:.1} MB)]", p.file_name().unwrap_or_default().to_string_lossy(), size as f64 / 1048576.0))
                }
                e if LEGACY_DOC_EXTS.contains(&e) => {
                    Ok(format!("[Document: {} — text extraction not supported for .{} format]",
                        p.file_name().unwrap_or_default().to_string_lossy(), e))
                }
                _ => {
                    match fs::read_to_string(&path) {
                        Ok(content) => Ok(content),
                        Err(e) => {
                            let exists = p.exists();
                            if !exists {
                                Err(format!("File does not exist: '{}'", path))
                            } else {
                                Err(format!(
                                    "Failed to read file '{}' as text: {} (likely binary, locked, or non-UTF-8)",
                                    path, e,
                                ))
                            }
                        }
                    }
                }
            }
        })
    })
    .await
    .map_err(|e| format!("read_file blocking task join error: {e}"))?
}

/// Pre-process a file and cache the extracted text.
#[tauri::command]
pub async fn preprocess_file(path: String) -> Result<String, String> {
    // See `read_file` above for why `spawn_blocking` is required.
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("preprocess_file", || {
            let p = Path::new(&path);
            let ext = p
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();

            let text = match ext.as_str() {
                "pdf" => extract_pdf_text(&path)?,
                e if OFFICE_EXTS.contains(&e) => extract_office_text(&path, e)?,
                _ => return Ok("no preprocessing needed".to_string()),
            };

            write_cache(p, &text)?;
            Ok(text)
        })
    })
    .await
    .map_err(|e| format!("preprocess_file blocking task join error: {e}"))?
}

fn cache_path_for(original: &Path) -> std::path::PathBuf {
    let parent = original.parent().unwrap_or(Path::new("."));
    let cache_dir = parent.join(".cache");
    let file_name = original
        .file_name()
        .unwrap_or_default()
        .to_string_lossy();
    cache_dir.join(format!("{}.txt", file_name))
}

fn read_cache(original: &Path) -> Option<String> {
    let cache_path = cache_path_for(original);
    let original_modified = fs::metadata(original).ok()?.modified().ok()?;
    let cache_modified = fs::metadata(&cache_path).ok()?.modified().ok()?;
    if cache_modified >= original_modified {
        fs::read_to_string(&cache_path).ok()
    } else {
        None
    }
}

fn write_cache(original: &Path, text: &str) -> Result<(), String> {
    let cache_path = cache_path_for(original);
    if let Some(parent) = cache_path.parent() {
        fs::create_dir_all(parent).ok();
    }
    fs::write(&cache_path, text)
        .map_err(|e| format!("Failed to write cache: {}", e))
}

/// Global PDFium instance — the library prefers a single binding shared
/// across threads over repeatedly binding/unbinding.
static PDFIUM: std::sync::OnceLock<Result<pdfium_render::prelude::Pdfium, String>> =
    std::sync::OnceLock::new();

/// Serializes every PDFium call. PDFium's C library is documented as
/// safe across threads only when no PDFium object is touched from
/// two threads simultaneously — interleaved calls are UB and have
/// caused EXC_BAD_ACCESS segfaults on macOS ARM64 in production.
///
/// This mutex matters because our heavy fs commands are now `async
/// fn`, so Tauri schedules them on the tokio multi-threaded runtime
/// instead of running them on a single thread. Without this lock,
/// two concurrent `read_file`/`extract_*_pdf` calls can land on
/// different worker threads and interleave inside pdfium → crash.
///
/// We use `std::sync::Mutex` (not `tokio::sync::Mutex`) because the
/// lock is acquired *inside* `spawn_blocking`, never held across
/// `.await` — async-aware mutexes would just add overhead for no
/// benefit here.
static PDFIUM_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Acquire the PDFium serialization lock. Auto-recovers from poison
/// (a previous panic on a malformed PDF leaves the mutex poisoned,
/// but pdfium has no shared state for that panic to have corrupted —
/// the next caller can safely take the lock and proceed).
pub(crate) fn lock_pdfium() -> std::sync::MutexGuard<'static, ()> {
    PDFIUM_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Additional resource directory hint, set by the Tauri setup() callback
/// once the AppHandle is available. Lets the pdfium resolver find the
/// bundled dylib without re-implementing Tauri's platform-specific
/// resource-dir logic.
static RESOURCE_DIR_HINT: std::sync::OnceLock<std::path::PathBuf> =
    std::sync::OnceLock::new();

/// Called from Tauri's setup() with the resolved resource directory.
/// No-op if already set.
pub fn set_resource_dir_hint(dir: std::path::PathBuf) {
    let _ = RESOURCE_DIR_HINT.set(dir);
}

/// Enumerate plausible locations for the PDFium dynamic library on the
/// current platform. Order from most specific to least:
///   1. `$PDFIUM_DYNAMIC_LIB_PATH` env var (local dev convenience)
///   2. Tauri resource dir (set via setup()) — the authoritative location
///   3. Paths relative to the executable where Tauri's bundler lands
///      resources on each platform (macOS Frameworks / Resources /
///      MacOS dir, Windows sibling, Linux sibling)
///   4. OS dynamic loader search path (last resort)
fn pdfium_candidate_paths() -> Vec<String> {
    let mut v: Vec<String> = Vec::new();

    if let Ok(p) = std::env::var("PDFIUM_DYNAMIC_LIB_PATH") {
        v.push(p);
    }

    // Tauri-resolved resource directory (set during setup()).
    //
    // Tauri's `bundle.resources` array form preserves relative paths,
    // so `"pdfium/pdfium.dll"` in tauri.<target>.conf.json lands at
    // `<resource_dir>/pdfium/pdfium.dll` — NOT at the root. Older
    // versions of this function only probed the root, which made
    // Windows installs fail with "Failed to locate Pdfium library"
    // (OS error 126) even though the DLL was in the installer.
    // We now probe both the `pdfium/` subdir (where the current
    // bundle config actually puts it) and the root (in case a future
    // config change flattens it).
    if let Some(resource_dir) = RESOURCE_DIR_HINT.get() {
        let push = |v: &mut Vec<String>, p: std::path::PathBuf| {
            v.push(p.to_string_lossy().into_owned());
        };
        #[cfg(target_os = "macos")]
        {
            push(&mut v, resource_dir.join("pdfium").join("libpdfium.dylib"));
            push(&mut v, resource_dir.join("libpdfium.dylib"));
        }
        #[cfg(target_os = "windows")]
        {
            push(&mut v, resource_dir.join("pdfium").join("pdfium.dll"));
            push(&mut v, resource_dir.join("pdfium").join("libpdfium.dll"));
            push(&mut v, resource_dir.join("pdfium.dll"));
            push(&mut v, resource_dir.join("libpdfium.dll"));
        }
        #[cfg(target_os = "linux")]
        {
            push(&mut v, resource_dir.join("pdfium").join("libpdfium.so"));
            push(&mut v, resource_dir.join("libpdfium.so"));
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let push = |v: &mut Vec<String>, p: std::path::PathBuf| {
                v.push(p.to_string_lossy().into_owned());
            };

            #[cfg(target_os = "macos")]
            {
                // Tauri .app bundle layout:
                //   Contents/MacOS/<binary>
                //   Contents/Frameworks/libpdfium.dylib   ← preferred (macOS config uses bundle.macOS.frameworks)
                //   Contents/Resources/libpdfium.dylib    ← fallback
                //   Contents/Resources/pdfium/libpdfium.dylib  ← if array-form resources ever used on macOS
                push(&mut v, exe_dir.join("../Frameworks/libpdfium.dylib"));
                push(&mut v, exe_dir.join("../Resources/pdfium/libpdfium.dylib"));
                push(&mut v, exe_dir.join("../Resources/libpdfium.dylib"));
                push(&mut v, exe_dir.join("libpdfium.dylib"));
            }

            #[cfg(target_os = "windows")]
            {
                // bblanchon/pdfium-binaries ships the Windows DLL as
                // `pdfium.dll` (no `lib` prefix). Probe flat and
                // `pdfium/` subdir forms at both exe root and the
                // classic Tauri `resources/` sibling — covers every
                // layout variant we've observed across NSIS / MSI /
                // portable builds.
                push(&mut v, exe_dir.join("pdfium.dll"));
                push(&mut v, exe_dir.join("pdfium").join("pdfium.dll"));
                push(&mut v, exe_dir.join("libpdfium.dll"));
                push(&mut v, exe_dir.join("resources").join("pdfium.dll"));
                push(&mut v, exe_dir.join("resources").join("pdfium").join("pdfium.dll"));
            }

            #[cfg(target_os = "linux")]
            {
                push(&mut v, exe_dir.join("libpdfium.so"));
                push(&mut v, exe_dir.join("pdfium").join("libpdfium.so"));
                push(&mut v, exe_dir.join("resources").join("libpdfium.so"));
                push(&mut v, exe_dir.join("resources").join("pdfium").join("libpdfium.so"));
                push(&mut v, exe_dir.join("../lib/libpdfium.so"));
            }
        }
    }

    v
}

pub(crate) fn pdfium() -> Result<&'static pdfium_render::prelude::Pdfium, String> {
    PDFIUM
        .get_or_init(|| {
            use pdfium_render::prelude::*;
            let candidates = pdfium_candidate_paths();
            for path in &candidates {
                if let Ok(bindings) = Pdfium::bind_to_library(path) {
                    eprintln!("[pdfium] loaded dynamic library from {path}");
                    return Ok(Pdfium::new(bindings));
                }
            }
            // Last resort: let the OS dynamic loader find it.
            Pdfium::bind_to_system_library()
                .map(Pdfium::new)
                .map_err(|e| {
                    format!(
                        "Failed to locate Pdfium library. Tried: {} — and the system search path. Last error: {e}",
                        if candidates.is_empty() {
                            "(no candidates)".to_string()
                        } else {
                            candidates.join(", ")
                        }
                    )
                })
        })
        .as_ref()
        .map_err(|e| e.clone())
}

/// Extract a PDF as markdown — text + per-page image references
/// when the file lives under a project's `raw/sources/` (the
/// layout the import pipeline produces). Falls back to text-only
/// when the PDF is opened from anywhere else.
///
/// Layout heuristic: a PDF at `<project>/raw/sources/<name>.pdf`
/// implies project root = `<project>` and image dest =
/// `<project>/raw/assets/<name>/`. We use absolute filesystem paths
/// in the emitted `![](url)` references so the markdown previews
/// (raw-source view AND wiki-summary view) both render via
/// `convertFileSrc` without anyone having to know which directory
/// they're rendering from.
///
/// Lock: delegates to `extract_pdf_markdown`, which acquires the
/// pdfium lock internally. We must NOT take it here too —
/// `std::sync::Mutex` is non-reentrant.
fn extract_pdf_text(path: &str) -> Result<String, String> {
    use crate::commands::extract_images::{extract_pdf_markdown, ExtractOptions};

    let p = Path::new(path);
    let parent = p.parent();
    let stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();

    // The path-component check uses `ends_with` on `Path` which
    // matches the LAST component (not a string-suffix check), so
    // `/foo/raw/sources/bar.pdf` correctly identifies as under
    // `raw/sources/` while `/foo/braw/source-thing/bar.pdf` does
    // not.
    let parent_is_sources = parent.map(|d| d.ends_with("sources")).unwrap_or(false);
    let raw_dir = parent.and_then(|d| d.parent());
    let raw_is_raw = raw_dir.map(|d| d.ends_with("raw")).unwrap_or(false);
    let project_root = if parent_is_sources && raw_is_raw {
        raw_dir.and_then(|d| d.parent())
    } else {
        None
    };

    if let Some(root) = project_root {
        if !stem.is_empty() {
            let asset_dir = root.join("raw").join("assets").join(&stem);
            // Forward-slash absolute path so we don't ship `\` into
            // markdown that the JS-side resolver would then have to
            // re-normalize. The resolver does handle backslashes,
            // but emitting clean URLs in the first place avoids
            // surprises in cache files we save to disk.
            let url_prefix = asset_dir.to_string_lossy().replace('\\', "/");
            return extract_pdf_markdown(
                path,
                Some(&asset_dir),
                &url_prefix,
                &ExtractOptions::default(),
            );
        }
    }

    // PDFs not under <project>/raw/sources/ — text-only fallback.
    // Skip the image side of the extraction entirely (no media
    // destination → extract_pdf_markdown only writes text + page
    // headers, no pdfium image-object enumeration).
    extract_pdf_markdown(path, None, "", &ExtractOptions::default())
}

/// Extract text from Office Open XML formats, converting to Markdown.
fn extract_office_text(path: &str, ext: &str) -> Result<String, String> {
    // Spreadsheets: use calamine (supports xlsx, xls, ods)
    if matches!(ext, "xlsx" | "xls" | "ods") {
        return extract_spreadsheet(path);
    }

    // DOCX: use docx-rs library for proper parsing
    if ext == "docx" {
        return extract_docx_with_library(path);
    }

    // PPTX and ODF: use ZIP-based parsing
    let file = fs::File::open(path)
        .map_err(|e| format!("Failed to open '{}': {}", path, e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Failed to read ZIP archive '{}': {}", path, e))?;

    match ext {
        "pptx" => extract_pptx_markdown(&mut archive),
        "odt" | "odp" => extract_odf_text(&mut archive),
        _ => Ok("[Unsupported format]".to_string()),
    }
}

/// Extract DOCX using docx-rs library for proper structural parsing.
fn extract_docx_with_library(path: &str) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| format!("Failed to read DOCX '{}': {}", path, e))?;
    let docx = docx_rs::read_docx(&bytes)
        .map_err(|e| format!("Failed to parse DOCX '{}': {:?}", path, e))?;

    let mut result = String::new();

    for child in docx.document.children {
        match child {
            docx_rs::DocumentChild::Paragraph(para) => {
                let mut para_text = String::new();
                let mut is_heading = false;
                let mut heading_level: u8 = 1;

                // Check paragraph style for headings
                if let Some(style) = &para.property.style {
                    let style_val = &style.val;
                    if style_val.contains("Heading") || style_val.contains("heading") {
                        is_heading = true;
                        // Extract level number
                        for ch in style_val.chars() {
                            if ch.is_ascii_digit() {
                                heading_level = ch.to_digit(10).unwrap_or(1) as u8;
                                break;
                            }
                        }
                    }
                }

                // Check for list (numbering)
                let is_list = para.property.numbering_property.is_some();

                // Extract text from runs
                for child in &para.children {
                    if let docx_rs::ParagraphChild::Run(run) = child {
                        let is_bold = run.run_property.bold.is_some();
                        let is_italic = run.run_property.italic.is_some();

                        for run_child in &run.children {
                            if let docx_rs::RunChild::Text(text) = run_child {
                                let t = &text.text;
                                if is_bold && is_italic {
                                    para_text.push_str(&format!("***{}***", t));
                                } else if is_bold {
                                    para_text.push_str(&format!("**{}**", t));
                                } else if is_italic {
                                    para_text.push_str(&format!("*{}*", t));
                                } else {
                                    para_text.push_str(t);
                                }
                            }
                        }
                    }
                }

                let text = para_text.trim().to_string();
                if text.is_empty() { continue; }

                if is_heading {
                    let prefix = "#".repeat(heading_level as usize);
                    result.push_str(&format!("{} {}\n\n", prefix, text));
                } else if is_list {
                    result.push_str(&format!("- {}\n", text));
                } else {
                    result.push_str(&text);
                    result.push_str("\n\n");
                }
            }
            docx_rs::DocumentChild::Table(table) => {
                let mut rows: Vec<Vec<String>> = Vec::new();
                for row in &table.rows {
                    {
                        let docx_rs::TableChild::TableRow(tr) = row;
                        let mut cells: Vec<String> = Vec::new();
                        for cell in &tr.cells {
                            {
                                let docx_rs::TableRowChild::TableCell(tc) = cell;
                                let mut cell_text = String::new();
                                for child in &tc.children {
                                    if let docx_rs::TableCellContent::Paragraph(para) = child {
                                        for pchild in &para.children {
                                            if let docx_rs::ParagraphChild::Run(run) = pchild {
                                                for rc in &run.children {
                                                    if let docx_rs::RunChild::Text(t) = rc {
                                                        cell_text.push_str(&t.text);
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                                cells.push(cell_text.trim().replace('|', "\\|"));
                            }
                        }
                        rows.push(cells);
                    }
                }
                if !rows.is_empty() {
                    let max_cols = rows.iter().map(|r| r.len()).max().unwrap_or(0);
                    for (i, row) in rows.iter().enumerate() {
                        let mut padded = row.clone();
                        padded.resize(max_cols, String::new());
                        result.push_str("| ");
                        result.push_str(&padded.join(" | "));
                        result.push_str(" |\n");
                        if i == 0 {
                            result.push('|');
                            for _ in 0..max_cols { result.push_str(" --- |"); }
                            result.push('\n');
                        }
                    }
                    result.push('\n');
                }
            }
            _ => {}
        }
    }

    if result.trim().is_empty() {
        // Fallback to ZIP-based extraction
        let file = fs::File::open(path).map_err(|e| e.to_string())?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
        extract_docx_markdown(&mut archive)
    } else {
        Ok(result)
    }
}

fn read_zip_file(archive: &mut zip::ZipArchive<fs::File>, name: &str) -> Option<String> {
    let mut file = archive.by_name(name).ok()?;
    let mut content = String::new();
    file.read_to_string(&mut content).ok()?;
    Some(content)
}

fn decode_xml_entities(text: &str) -> String {
    text.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&#10;", "\n")
        .replace("&#13;", "")
}

/// Extract DOCX to Markdown preserving headings, paragraphs, lists, tables, bold/italic.
fn extract_docx_markdown(archive: &mut zip::ZipArchive<fs::File>) -> Result<String, String> {
    let xml = read_zip_file(archive, "word/document.xml")
        .ok_or_else(|| "No document.xml found".to_string())?;

    let mut result = String::new();
    let mut i = 0;
    let chars: Vec<char> = xml.chars().collect();
    let len = chars.len();

    let mut paragraph_text = String::new();
    let mut is_heading = false;
    let mut heading_level: u8 = 1;
    let mut is_bold = false;
    let mut is_italic = false;
    let mut in_table = false;
    let mut table_row: Vec<String> = Vec::new();
    let mut table_cell_text = String::new();
    let mut in_cell = false;
    let mut is_first_table_row = true;
    let mut in_list_item = false;

    while i < len {
        if chars[i] == '<' {
            // Read tag name
            i += 1;
            let is_closing = i < len && chars[i] == '/';
            if is_closing { i += 1; }

            let mut tag_name = String::new();
            while i < len && chars[i] != '>' && chars[i] != ' ' && chars[i] != '/' {
                tag_name.push(chars[i]);
                i += 1;
            }

            // Read rest of tag to find attributes
            let mut tag_content = String::new();
            while i < len && chars[i] != '>' {
                tag_content.push(chars[i]);
                i += 1;
            }
            if i < len { i += 1; } // skip >

            match tag_name.as_str() {
                // Paragraph start
                "w:p" if !is_closing => {
                    paragraph_text.clear();
                    is_heading = false;
                    in_list_item = false;
                }
                // Paragraph end — flush
                "w:p" if is_closing => {
                    let text = paragraph_text.trim().to_string();
                    if !text.is_empty() {
                        if in_table && in_cell {
                            table_cell_text = text;
                        } else if is_heading {
                            let prefix = "#".repeat(heading_level as usize);
                            result.push_str(&format!("{} {}\n\n", prefix, text));
                        } else if in_list_item {
                            result.push_str(&format!("- {}\n", text));
                        } else {
                            result.push_str(&text);
                            result.push_str("\n\n");
                        }
                    }
                    paragraph_text.clear();
                }
                // Heading style detection
                "w:pStyle" if !is_closing => {
                    if tag_content.contains("Heading") || tag_content.contains("heading") {
                        is_heading = true;
                        // Try to extract heading level from val="Heading1" etc.
                        if let Some(pos) = tag_content.find("Heading") {
                            let after = &tag_content[pos + 7..];
                            if let Some(ch) = after.chars().next() {
                                if ch.is_ascii_digit() {
                                    heading_level = ch.to_digit(10).unwrap_or(1) as u8;
                                }
                            }
                        }
                    }
                    if tag_content.contains("ListParagraph") || tag_content.contains("listParagraph") {
                        in_list_item = true;
                    }
                }
                // Bold
                "w:b" if !is_closing && !tag_content.contains("w:val=\"0\"") && !tag_content.contains("w:val=\"false\"") => {
                    is_bold = true;
                }
                // Italic
                "w:i" if !is_closing && !tag_content.contains("w:val=\"0\"") && !tag_content.contains("w:val=\"false\"") => {
                    is_italic = true;
                }
                // Run end — apply formatting
                "w:r" if is_closing => {
                    is_bold = false;
                    is_italic = false;
                }
                // Text content
                "w:t" if !is_closing => {
                    // Read text until </w:t>
                    let mut text = String::new();
                    while i < len {
                        if chars[i] == '<' {
                            break;
                        }
                        text.push(chars[i]);
                        i += 1;
                    }
                    let decoded = decode_xml_entities(&text);
                    if is_bold && is_italic {
                        paragraph_text.push_str(&format!("***{}***", decoded));
                    } else if is_bold {
                        paragraph_text.push_str(&format!("**{}**", decoded));
                    } else if is_italic {
                        paragraph_text.push_str(&format!("*{}*", decoded));
                    } else {
                        paragraph_text.push_str(&decoded);
                    }
                }
                // Table handling
                "w:tbl" if !is_closing => {
                    in_table = true;
                    is_first_table_row = true;
                }
                "w:tbl" if is_closing => {
                    in_table = false;
                    result.push('\n');
                }
                "w:tr" if !is_closing => {
                    table_row.clear();
                }
                "w:tr" if is_closing => {
                    if !table_row.is_empty() {
                        result.push_str("| ");
                        result.push_str(&table_row.join(" | "));
                        result.push_str(" |\n");
                        if is_first_table_row {
                            result.push_str("|");
                            for _ in &table_row {
                                result.push_str(" --- |");
                            }
                            result.push('\n');
                            is_first_table_row = false;
                        }
                    }
                }
                "w:tc" if !is_closing => {
                    in_cell = true;
                    table_cell_text.clear();
                }
                "w:tc" if is_closing => {
                    table_row.push(table_cell_text.trim().to_string());
                    in_cell = false;
                    table_cell_text.clear();
                }
                _ => {}
            }
        } else {
            i += 1;
        }
    }

    if result.trim().is_empty() {
        Ok("[Could not extract structured text from DOCX]".to_string())
    } else {
        Ok(result)
    }
}

/// Extract PPTX to Markdown with slide numbers and structure.
fn extract_pptx_markdown(archive: &mut zip::ZipArchive<fs::File>) -> Result<String, String> {
    let mut slide_names: Vec<String> = (0..archive.len())
        .filter_map(|i| archive.by_index(i).ok().map(|f| f.name().to_string()))
        .filter(|n| n.starts_with("ppt/slides/slide") && n.ends_with(".xml"))
        .collect();

    // Sort by slide number
    slide_names.sort_by(|a, b| {
        let num_a = a.trim_start_matches("ppt/slides/slide").trim_end_matches(".xml").parse::<u32>().unwrap_or(0);
        let num_b = b.trim_start_matches("ppt/slides/slide").trim_end_matches(".xml").parse::<u32>().unwrap_or(0);
        num_a.cmp(&num_b)
    });

    let mut result = String::new();

    for (idx, slide_name) in slide_names.iter().enumerate() {
        let xml = match read_zip_file(archive, slide_name) {
            Some(x) => x,
            None => continue,
        };

        result.push_str(&format!("## Slide {}\n\n", idx + 1));

        // Extract text from <a:t>...</a:t> tags, group by <a:p>...</a:p> paragraphs
        // Use string split approach to avoid byte/char index mismatch with CJK characters
        let mut paragraphs: Vec<String> = Vec::new();

        for para_part in xml.split("<a:p") {
            let mut para_text = String::new();
            for t_part in para_part.split("<a:t") {
                if let Some(close_pos) = t_part.find("</a:t>") {
                    if let Some(gt_pos) = t_part.find('>') {
                        if gt_pos < close_pos {
                            let text = &t_part[gt_pos + 1..close_pos];
                            para_text.push_str(&decode_xml_entities(text));
                        }
                    }
                }
            }
            let trimmed = para_text.trim().to_string();
            if !trimmed.is_empty() {
                paragraphs.push(trimmed);
            }
        }

        // First paragraph is usually the slide title
        if let Some(title) = paragraphs.first() {
            result.push_str(&format!("**{}**\n\n", title));
            for para in paragraphs.iter().skip(1) {
                result.push_str(&format!("- {}\n", para));
            }
        }
        result.push('\n');
    }

    if result.trim().is_empty() {
        Ok("[Could not extract text from PPTX]".to_string())
    } else {
        Ok(result)
    }
}

/// Extract spreadsheet to Markdown using calamine (supports xlsx, xls, ods).
fn extract_spreadsheet(path: &str) -> Result<String, String> {
    let mut workbook = open_workbook_auto(path)
        .map_err(|e| format!("Failed to open spreadsheet '{}': {}", path, e))?;

    let mut result = String::new();
    let sheet_names = workbook.sheet_names().to_vec();

    for sheet_name in &sheet_names {
        if let Ok(range) = workbook.worksheet_range(sheet_name) {
            if range.is_empty() { continue; }

            if sheet_names.len() > 1 {
                result.push_str(&format!("## {}\n\n", sheet_name));
            }

            let mut rows: Vec<Vec<String>> = Vec::new();
            let mut max_cols = 0;

            for row in range.rows() {
                let cells: Vec<String> = row.iter().map(|cell| {
                    match cell {
                        Data::Empty => String::new(),
                        Data::String(s) => s.clone(),
                        Data::Float(f) => {
                            if *f == (*f as i64) as f64 {
                                format!("{}", *f as i64)
                            } else {
                                format!("{:.2}", f)
                            }
                        }
                        Data::Int(i) => i.to_string(),
                        Data::Bool(b) => b.to_string(),
                        Data::DateTime(dt) => format!("{}", dt),
                        Data::DateTimeIso(s) => s.clone(),
                        Data::DurationIso(s) => s.clone(),
                        Data::Error(e) => format!("ERR:{:?}", e),
                    }
                }).collect();
                if cells.len() > max_cols { max_cols = cells.len(); }
                rows.push(cells);
            }

            // Skip empty sheets
            if rows.is_empty() || max_cols == 0 { continue; }

            for (i, row) in rows.iter().enumerate() {
                let mut padded = row.clone();
                padded.resize(max_cols, String::new());
                // Escape pipe characters in cell values
                let escaped: Vec<String> = padded.iter().map(|c| c.replace('|', "\\|")).collect();
                result.push_str("| ");
                result.push_str(&escaped.join(" | "));
                result.push_str(" |\n");

                if i == 0 {
                    result.push('|');
                    for _ in 0..max_cols { result.push_str(" --- |"); }
                    result.push('\n');
                }
            }
            result.push('\n');
        }
    }

    if result.trim().is_empty() {
        Ok("[Could not extract data from spreadsheet]".to_string())
    } else {
        Ok(result)
    }
}

/// Extract OpenDocument format text (basic).
fn extract_odf_text(archive: &mut zip::ZipArchive<fs::File>) -> Result<String, String> {
    let xml = read_zip_file(archive, "content.xml")
        .ok_or_else(|| "No content.xml found".to_string())?;

    let mut result = String::new();
    let mut in_tag = false;

    for ch in xml.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                result.push(' ');
            }
            _ if !in_tag => result.push(ch),
            _ => {}
        }
    }

    let cleaned = decode_xml_entities(&result);
    let lines: Vec<&str> = cleaned.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();

    if lines.is_empty() {
        Ok("[Could not extract text from this file]".to_string())
    } else {
        Ok(lines.join("\n\n"))
    }
}

#[tauri::command]
pub async fn write_file(path: String, contents: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("write_file", || {
            let p = Path::new(&path);
            if let Some(parent) = p.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create parent dirs for '{}': {}", path, e))?;
            }
            fs::write(&path, contents)
                .map_err(|e| format!("Failed to write file '{}': {}", path, e))
        })
    })
    .await
    .map_err(|e| format!("write_file blocking task join error: {e}"))?
}

#[tauri::command]
pub async fn list_directory(path: String) -> Result<Vec<FileNode>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("list_directory", || {
            let p = Path::new(&path);
            if !p.exists() {
                return Err(format!("Path does not exist: '{}'", path));
            }
            if !p.is_dir() {
                return Err(format!("Path is not a directory: '{}'", path));
            }
            let nodes = build_tree(p, 0, 30)?;
            Ok(nodes)
        })
    })
    .await
    .map_err(|e| format!("list_directory blocking task join error: {e}"))?
}

fn build_tree(dir: &Path, depth: usize, max_depth: usize) -> Result<Vec<FileNode>, String> {
    if depth >= max_depth {
        return Ok(vec![]);
    }

    let mut entries: Vec<_> = fs::read_dir(dir)
        .map_err(|e| format!("Failed to read directory '{}': {}", dir.display(), e))?
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            // Skip dotfiles
            entry
                .file_name()
                .to_str()
                .map(|n| !n.starts_with('.'))
                .unwrap_or(false)
        })
        .collect();

    // Sort: directories first, then alphabetical within each group
    entries.sort_by(|a, b| {
        let a_is_dir = a.path().is_dir();
        let b_is_dir = b.path().is_dir();
        match (a_is_dir, b_is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.file_name().cmp(&b.file_name()),
        }
    });

    let mut nodes = Vec::new();
    for entry in entries {
        let entry_path = entry.path();
        let name = entry
            .file_name()
            .to_str()
            .unwrap_or("")
            .to_string();
        // Always return forward-slash paths so the TS layer can compare
        // and compose paths consistently across Windows and Unix. Windows
        // APIs accept forward slashes, so normalizing here is safe and
        // prevents a whole class of bugs where TS-constructed `/` paths
        // fail to match Rust-returned `\` paths.
        let path_str = entry_path.to_string_lossy().replace('\\', "/");
        let is_dir = entry_path.is_dir();

        let children = if is_dir {
            let kids = build_tree(&entry_path, depth + 1, max_depth)?;
            if kids.is_empty() {
                None
            } else {
                Some(kids)
            }
        } else {
            None
        };

        nodes.push(FileNode {
            name,
            path: path_str,
            is_dir,
            children,
        });
    }

    Ok(nodes)
}

#[tauri::command]
pub async fn copy_file(source: String, destination: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("copy_file", || {
            let dest = Path::new(&destination);
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create parent dirs: {}", e))?;
            }
            fs::copy(&source, &destination)
                .map_err(|e| format!("Failed to copy '{}' to '{}': {}", source, destination, e))?;
            Ok(())
        })
    })
    .await
    .map_err(|e| format!("copy_file blocking task join error: {e}"))?
}

/// Recursively copy a directory, preserving structure.
/// Returns list of copied file paths (destination paths).
#[tauri::command]
pub async fn copy_directory(source: String, destination: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("copy_directory", || {
            let src = Path::new(&source);
            let dest = Path::new(&destination);

            if !src.is_dir() {
                return Err(format!("'{}' is not a directory", source));
            }

            let mut copied_files = Vec::new();

            fn copy_recursive(
                src: &Path,
                dest: &Path,
                files: &mut Vec<String>,
            ) -> Result<(), String> {
                fs::create_dir_all(dest)
                    .map_err(|e| format!("Failed to create dir '{}': {}", dest.display(), e))?;

                let entries = fs::read_dir(src)
                    .map_err(|e| format!("Failed to read dir '{}': {}", src.display(), e))?;

                for entry in entries {
                    let entry = entry.map_err(|e| format!("Dir entry error: {}", e))?;
                    let path = entry.path();
                    let name = entry.file_name();
                    let dest_path = dest.join(&name);

                    if name.to_string_lossy().starts_with('.') {
                        continue;
                    }

                    if path.is_dir() {
                        copy_recursive(&path, &dest_path, files)?;
                    } else {
                        fs::copy(&path, &dest_path).map_err(|e| {
                            format!("Failed to copy '{}': {}", path.display(), e)
                        })?;
                        files.push(dest_path.to_string_lossy().replace('\\', "/"));
                    }
                }
                Ok(())
            }

            copy_recursive(src, dest, &mut copied_files)?;
            Ok(copied_files)
        })
    })
    .await
    .map_err(|e| format!("copy_directory blocking task join error: {e}"))?
}

#[tauri::command]
pub async fn delete_file(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("delete_file", || {
            let p = Path::new(&path);
            if p.is_dir() {
                fs::remove_dir_all(&path)
                    .map_err(|e| format!("Failed to delete directory '{}': {}", path, e))
            } else {
                fs::remove_file(&path)
                    .map_err(|e| format!("Failed to delete file '{}': {}", path, e))
            }
        })
    })
    .await
    .map_err(|e| format!("delete_file blocking task join error: {e}"))?
}

/// Find wiki pages that reference a given source file name.
/// Scans all .md files under wiki/ for the source filename in frontmatter or content.
#[tauri::command]
pub async fn find_related_wiki_pages(project_path: String, source_name: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("find_related_wiki_pages", || {
            let wiki_dir = Path::new(&project_path).join("wiki");
            if !wiki_dir.is_dir() {
                return Ok(vec![]);
            }

            let mut related = Vec::new();
            collect_related_pages(&wiki_dir, &source_name, &mut related)?;
            Ok(related)
        })
    })
    .await
    .map_err(|e| format!("find_related_wiki_pages blocking task join error: {e}"))?
}

fn collect_related_pages(dir: &Path, source_name: &str, results: &mut Vec<String>) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;

    // Get just the filename without path — use Path for cross-platform separator handling
    let source_path = std::path::Path::new(source_name);
    let file_name = source_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(source_name);
    let file_name_lower = file_name.to_lowercase();

    // Derive stem (filename without extension) for source summary matching
    let file_stem = file_name
        .rsplit('.')
        .skip(1)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join(".");
    let file_stem_lower = if file_stem.is_empty() { file_name_lower.clone() } else { file_stem.to_lowercase() };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_related_pages(&path, source_name, results)?;
        } else if path.extension().map(|e| e == "md").unwrap_or(false) {
            let fname = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            // Skip index.md, log.md, overview.md — updated separately
            if fname == "index.md" || fname == "log.md" || fname == "overview.md" {
                continue;
            }

            if let Ok(content) = fs::read_to_string(&path) {
                let content_lower = content.to_lowercase();

                // Match 1: frontmatter sources field contains the exact filename
                // e.g., sources: ["2603.25723v1.pdf"]
                let sources_match = content_lower.contains(&format!("\"{}\"", file_name_lower))
                    || content_lower.contains(&format!("'{}'", file_name_lower));

                // Match 2: source summary page (wiki/sources/{stem}.md)
                // Use Path component iteration to avoid hardcoded separator assumptions
                let is_in_sources_dir = path
                    .components()
                    .any(|c| c.as_os_str() == "sources");
                let is_source_summary = is_in_sources_dir
                    && fname.to_lowercase().starts_with(&file_stem_lower);

                // Match 3: the page's *sources block* mentions the
                // filename. Covers the multi-line YAML list form
                //
                //   sources:
                //     - test.md         (unquoted, missed by Match 1)
                //     - "other.md"
                //
                // Previous version substring-matched against the ENTIRE
                // frontmatter, which false-positived whenever the
                // filename happened to appear in title / description /
                // any other field — those pages were then handed to
                // the TS delete flow and, because their actual sources
                // list didn't include the deleted file, silently
                // wiped. Tightened: scope the substring check to the
                // `sources:` block only (inline line + any indented
                // continuation lines of a YAML list).
                let frontmatter_match = if content.starts_with("---\n") {
                    if let Some(fm_end_rel) = content[4..].find("\n---") {
                        let frontmatter = &content[4..4 + fm_end_rel].to_lowercase();
                        let mut found = false;
                        let mut in_sources_block = false;
                        for line in frontmatter.split('\n') {
                            if line.starts_with("sources:") {
                                // Inline-form `sources: [...]` lives
                                // entirely on this one line; check it.
                                if line.contains(&file_name_lower) {
                                    found = true;
                                    break;
                                }
                                in_sources_block = true;
                                continue;
                            }
                            if in_sources_block {
                                // Continuation lines of a YAML list are
                                // indented; an un-indented line means
                                // we've left the sources block for
                                // another top-level field.
                                if line.is_empty() || line.starts_with(' ') || line.starts_with('\t') {
                                    if line.contains(&file_name_lower) {
                                        found = true;
                                        break;
                                    }
                                } else {
                                    in_sources_block = false;
                                }
                            }
                        }
                        found
                    } else {
                        false
                    }
                } else {
                    false
                };

                if sources_match || is_source_summary || frontmatter_match {
                    // Normalize to forward slashes — matches build_tree /
                    // copy_directory so TS-side comparisons work on Windows.
                    results.push(path.to_string_lossy().replace('\\', "/"));
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn create_directory(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("create_directory", || {
            fs::create_dir_all(&path)
                .map_err(|e| format!("Failed to create directory '{}': {}", path, e))
        })
    })
    .await
    .map_err(|e| format!("create_directory blocking task join error: {e}"))?
}

/// Read any file as base64 + a guessed mime type. Used by the
/// vision-caption pipeline to slurp extracted image bytes off disk
/// without round-tripping them through the JS string-as-UTF8 path
/// (`read_file` would corrupt PNG bytes — they aren't valid UTF-8).
///
/// Mime detection is by extension only — the caption helper doesn't
/// care about exact accuracy (vision models accept any common
/// raster format), and the alternative (sniffing magic bytes via
/// `infer` or similar) adds a dependency for marginal benefit.
/// Unknown extensions fall back to `application/octet-stream`,
/// which all major vision endpoints accept (Anthropic / OpenAI both
/// also support that as a generic fallback).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileBase64 {
    pub base64: String,
    pub mime_type: String,
}

#[tauri::command]
pub async fn read_file_as_base64(path: String) -> Result<FileBase64, String> {
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("read_file_as_base64", || {
            let bytes = fs::read(&path)
                .map_err(|e| format!("Failed to read '{}': {}", path, e))?;
            let p = Path::new(&path);
            let ext = p
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            let mime_type = match ext.as_str() {
                "png" => "image/png",
                "jpg" | "jpeg" => "image/jpeg",
                "gif" => "image/gif",
                "webp" => "image/webp",
                "bmp" => "image/bmp",
                "tiff" | "tif" => "image/tiff",
                "svg" => "image/svg+xml",
                _ => "application/octet-stream",
            }
            .to_string();
            Ok(FileBase64 {
                base64: B64.encode(&bytes),
                mime_type,
            })
        })
    })
    .await
    .map_err(|e| format!("read_file_as_base64 blocking task join error: {e}"))?
}

/// Cheap existence check without reading or classifying the file.
/// Returns true iff `path` refers to something on disk right now.
#[tauri::command]
pub async fn file_exists(path: String) -> Result<bool, String> {
    // `Path::exists()` does a `stat(2)` syscall — fast on a hot
    // cache, but a blocking syscall nonetheless. Wrapping it keeps
    // the rule "no sync IO on tokio worker threads" uniform across
    // every fs command rather than carving out an exception that's
    // easy to violate later.
    tauri::async_runtime::spawn_blocking(move || {
        run_guarded("file_exists", || Ok(Path::new(&path).exists()))
    })
    .await
    .map_err(|e| format!("file_exists blocking task join error: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Write `bytes` to a fresh tmp path with `.pdf` suffix and return
    /// the path (the OS tmpdir is NOT cleaned up — acceptable for tests).
    fn tmp_pdf_with_bytes(bytes: &[u8]) -> String {
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "panic-guard-{}.pdf",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut f = fs::File::create(&path).unwrap();
        f.write_all(bytes).unwrap();
        path.to_string_lossy().to_string()
    }

    /// Verify read_file does NOT crash the test process on malformed PDFs.
    /// We try a handful of payloads that have historically caused
    /// pdf-extract/lopdf panics — any process abort would fail the test
    /// runner before it can report.
    ///
    /// `multi_thread` flavor: `read_file` now uses
    /// `tauri::async_runtime::spawn_blocking`, which moves work onto
    /// the tokio blocking pool. The blocking pool requires a multi-
    /// threaded runtime — the default `#[tokio::test]` is single-
    /// threaded current-thread, on which `.await` of a `spawn_blocking`
    /// future deadlocks.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn read_file_survives_malformed_pdf_inputs() {
        let payloads: &[(&str, &[u8])] = &[
            ("empty", b""),
            ("not_a_pdf", b"this is plainly not a PDF file"),
            ("header_only", b"%PDF-1.4\n"),
            (
                "broken_xref",
                b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\nxref\nBROKENBROKEN\ntrailer\n<</Size 1>>\nstartxref\n999999\n%%EOF\n",
            ),
            (
                "junk_after_header",
                b"%PDF-1.4\n\x00\x01\x02\x03\x04\x05\x06\x07\xFF\xFE\xFDjunkgarbage",
            ),
        ];

        for (name, bytes) in payloads {
            let path = tmp_pdf_with_bytes(bytes);
            let result = read_file(path.clone()).await;
            let _ = fs::remove_file(&path);
            eprintln!("[{name}] => {:?}", result.as_ref().map(|s| &s[..s.len().min(80)]));
        }
    }

    /// Smoke test: a real PDF panic (synthesized) is caught. We can't
    /// guarantee that any particular byte sequence above actually panics
    /// pdf-extract across versions, so also trigger an explicit panic
    /// through read_file's guarded path.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn read_file_returns_err_on_missing_file_instead_of_panicking() {
        let result = read_file("/nonexistent/path/that/does/not/exist.pdf".to_string()).await;
        assert!(result.is_err() || result.is_ok()); // must at least return
    }

    /// Ad-hoc probe: run the production PDF extraction path against every
    /// .pdf under a user-provided directory and print a per-file report of
    /// Ok / Err (library returned an error) / Panic (library panicked and
    /// was caught by panic_guard). Gated with #[ignore] so it never runs
    /// in CI; execute locally with:
    ///
    ///   PDF_PROBE_DIR=/path/to/pdfs cargo test --lib \
    ///     -- --ignored --nocapture pdf_probe
    #[test]
    #[ignore = "local probe; set PDF_PROBE_DIR"]
    fn pdf_probe() {
        let dir = std::env::var("PDF_PROBE_DIR")
            .unwrap_or_else(|_| "/Users/nash_su/Downloads/pdftests".to_string());
        let root = std::path::Path::new(&dir);
        if !root.exists() {
            eprintln!("[pdf_probe] dir not found: {}", root.display());
            return;
        }

        let mut pdfs: Vec<std::path::PathBuf> = Vec::new();
        fn walk(d: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            if let Ok(entries) = fs::read_dir(d) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if p.is_dir() {
                        walk(&p, out);
                    } else if p.extension()
                        .and_then(|e| e.to_str())
                        .map(|e| e.eq_ignore_ascii_case("pdf"))
                        .unwrap_or(false)
                    {
                        out.push(p);
                    }
                }
            }
        }
        walk(root, &mut pdfs);
        pdfs.sort();

        eprintln!("\n[pdf_probe] found {} PDFs under {}\n", pdfs.len(), root.display());

        let mut ok = 0usize;
        let mut err = 0usize;
        let mut panicked = 0usize;

        for (idx, path) in pdfs.iter().enumerate() {
            let display = path.display().to_string();
            // Call extract_pdf_text directly (not read_file) so we bypass
            // the .cache sibling dir and always exercise the parser.
            let path_str = path.to_string_lossy().to_string();
            let result = std::panic::catch_unwind(|| extract_pdf_text(&path_str));
            match result {
                Ok(Ok(text)) => {
                    ok += 1;
                    eprintln!("[{:>3}/{}] OK     ({:>7} chars)  {}", idx + 1, pdfs.len(), text.len(), display);
                }
                Ok(Err(e)) => {
                    err += 1;
                    eprintln!("[{:>3}/{}] ERR    {}  →  {}", idx + 1, pdfs.len(), display, e);
                }
                Err(payload) => {
                    panicked += 1;
                    let msg = if let Some(s) = payload.downcast_ref::<String>() {
                        s.clone()
                    } else if let Some(s) = payload.downcast_ref::<&str>() {
                        (*s).to_string()
                    } else {
                        "(non-string panic)".to_string()
                    };
                    eprintln!("[{:>3}/{}] PANIC  {}  →  {}", idx + 1, pdfs.len(), display, msg);
                }
            }
        }

        eprintln!("\n[pdf_probe] summary: {} OK / {} ERR / {} PANIC (total {})", ok, err, panicked, pdfs.len());
    }

    // ── collect_related_pages: regression coverage for the three match ─────
    // strategies used by findRelatedWikiPages.
    //
    // Strategy 1: quoted filename anywhere in content
    //               (e.g. `sources: ["test.md"]` inline form)
    // Strategy 2: page lives under wiki/sources/ and starts with file stem
    //               (the source summary page)
    // Strategy 3: filename appears inside the frontmatter's sources BLOCK
    //               (tightened: no longer false-positives on `title:`
    //                `description:` or any other field that happens to
    //                include the filename as a substring)
    //
    // These tests are the regression guard for the Strategy 3 fix — before
    // the tightening, a page whose title included the deleted filename
    // would be surfaced here and then wrongly deleted downstream.

    fn make_wiki(files: &[(&str, &str)]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "wiki-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        for (rel, body) in files {
            let p = dir.join(rel);
            if let Some(parent) = p.parent() { fs::create_dir_all(parent).unwrap(); }
            fs::write(&p, body).unwrap();
        }
        dir
    }

    fn collect(wiki: &std::path::Path, source: &str) -> Vec<String> {
        let mut out = Vec::new();
        collect_related_pages(wiki, source, &mut out).unwrap();
        // Normalize to the wiki-relative suffix so assertions are
        // independent of the temp prefix.
        let prefix = wiki.to_string_lossy().replace('\\', "/");
        out.into_iter()
            .map(|p| {
                let p = p.replace('\\', "/");
                p.strip_prefix(&format!("{}/", prefix))
                    .map(str::to_string)
                    .unwrap_or(p)
            })
            .collect()
    }

    #[test]
    fn collect_related_strategy1_inline_quoted_sources() {
        let wiki = make_wiki(&[
            (
                "concepts/rope.md",
                "---\ntitle: RoPE\nsources: [\"test.md\"]\n---\nbody\n",
            ),
            (
                "concepts/unrelated.md",
                "---\ntitle: Unrelated\nsources: [\"other.md\"]\n---\nbody\n",
            ),
        ]);
        let mut got = collect(&wiki, "test.md");
        got.sort();
        assert_eq!(got, vec!["concepts/rope.md"]);
        let _ = fs::remove_dir_all(&wiki);
    }

    #[test]
    fn collect_related_strategy1_single_quoted_sources() {
        let wiki = make_wiki(&[(
            "concepts/rope.md",
            "---\ntitle: RoPE\nsources: ['test.md']\n---\nbody\n",
        )]);
        let got = collect(&wiki, "test.md");
        assert_eq!(got, vec!["concepts/rope.md"]);
        let _ = fs::remove_dir_all(&wiki);
    }

    #[test]
    fn collect_related_strategy2_source_summary_page() {
        // A page inside wiki/sources/ whose filename starts with the
        // deleted source's stem counts as the source-summary page —
        // kept linked even if its sources field happens to be missing.
        let wiki = make_wiki(&[
            (
                "sources/test.md",
                "---\ntitle: Test Summary\n---\nbody\n",
            ),
            (
                "concepts/unrelated.md",
                "---\ntitle: Unrelated\nsources: [\"other.md\"]\n---\nbody\n",
            ),
        ]);
        let got = collect(&wiki, "test.md");
        assert_eq!(got, vec!["sources/test.md"]);
        let _ = fs::remove_dir_all(&wiki);
    }

    #[test]
    fn collect_related_strategy3_multi_line_yaml_list() {
        // Multi-line YAML sources block with an unquoted entry — Strategy
        // 1 can't see this (no quotes), Strategy 3 has to walk the
        // sources block line by line.
        let wiki = make_wiki(&[(
            "concepts/rope.md",
            "---\ntitle: RoPE\nsources:\n  - test.md\n  - \"other.md\"\ntags: []\n---\nbody\n",
        )]);
        let got = collect(&wiki, "test.md");
        assert_eq!(got, vec!["concepts/rope.md"]);
        let _ = fs::remove_dir_all(&wiki);
    }

    #[test]
    fn collect_related_strategy3_does_not_false_positive_on_title_substring() {
        // Regression guard for the bug we just fixed: a page whose
        // title / description contains the deleted filename MUST NOT
        // be surfaced when its actual sources list is unrelated.
        // Before the fix, the whole frontmatter was substring-scanned
        // and this page would have been returned → downstream delete
        // flow → silent data loss on an innocent page.
        let wiki = make_wiki(&[
            (
                "concepts/rope.md",
                "---\ntitle: Analysis of test.md\ndescription: Discusses test.md in depth\nsources: [\"other.md\"]\n---\nbody\n",
            ),
            (
                "concepts/real-match.md",
                "---\ntitle: Real\nsources: [\"test.md\"]\n---\nbody\n",
            ),
        ]);
        let got = collect(&wiki, "test.md");
        // Only the real-match page is surfaced. The title-substring
        // page is correctly ignored now.
        assert_eq!(got, vec!["concepts/real-match.md"]);
        let _ = fs::remove_dir_all(&wiki);
    }

    #[test]
    fn collect_related_strategy3_stops_at_next_top_level_field() {
        // Scan must stop at the next top-level YAML key so that a
        // filename appearing in a later field (e.g. `notes:`) doesn't
        // get pulled into the sources block.
        let wiki = make_wiki(&[(
            "concepts/rope.md",
            "---\ntitle: RoPE\nsources:\n  - other.md\nnotes: See test.md for context\n---\nbody\n",
        )]);
        let got = collect(&wiki, "test.md");
        // sources block has only other.md; test.md appears in `notes:`
        // which is outside the block — must not match.
        assert!(got.is_empty(), "expected empty, got {got:?}");
        let _ = fs::remove_dir_all(&wiki);
    }

    #[test]
    fn collect_related_returns_empty_when_nothing_matches() {
        let wiki = make_wiki(&[(
            "concepts/unrelated.md",
            "---\ntitle: X\nsources: [\"other.md\"]\n---\nbody\n",
        )]);
        let got = collect(&wiki, "nonexistent.md");
        assert!(got.is_empty());
        let _ = fs::remove_dir_all(&wiki);
    }

    #[test]
    fn collect_related_skips_index_log_overview() {
        // Listing pages (index.md, log.md, overview.md) reference the
        // filename heavily but should never be returned here — they're
        // cleaned separately via the TS cleanup helpers.
        let wiki = make_wiki(&[
            (
                "index.md",
                "---\ntitle: Index\n---\n- [[Test]]\nsources: [\"test.md\"]\n",
            ),
            (
                "log.md",
                "---\ntitle: Log\n---\nIngested test.md on 2026-01-01\n",
            ),
            (
                "overview.md",
                "---\ntitle: Overview\n---\nCovers test.md and other.md\n",
            ),
            (
                "concepts/real.md",
                "---\ntitle: Real\nsources: [\"test.md\"]\n---\nbody\n",
            ),
        ]);
        let got = collect(&wiki, "test.md");
        assert_eq!(got, vec!["concepts/real.md"]);
        let _ = fs::remove_dir_all(&wiki);
    }

    #[test]
    fn collect_related_case_insensitive_filename_match() {
        let wiki = make_wiki(&[(
            "concepts/rope.md",
            "---\ntitle: RoPE\nsources: [\"Test.md\"]\n---\nbody\n",
        )]);
        let got = collect(&wiki, "test.md");
        assert_eq!(got, vec!["concepts/rope.md"]);
        let _ = fs::remove_dir_all(&wiki);
    }

    // ── copy_directory: folder import recursion + filtering ──────────
    //
    // The folder-import flow on the JS side calls this command and
    // expects:
    //   1. Recursion goes ALL the way down (no depth cap) — users
    //      drop trees with arbitrary nesting and every file inside
    //      should reach the wiki.
    //   2. Dotfiles / dot-directories are skipped (`.git`, `.cache`,
    //      `.DS_Store`) — otherwise a folder with a `.git/` would
    //      import megabytes of git plumbing as "source files."
    //   3. Returned paths are FLAT (one entry per file, regardless
    //      of depth) and use forward slashes (the JS layer normalizes
    //      everything to `/` before doing path comparisons).
    //
    // These are exactly the invariants `handleImportFolder` in
    // sources-view.tsx assumes — pinning them here keeps a future
    // refactor of the recursive copier from silently breaking the
    // folder import button.

    fn make_temp_dir(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "llmwiki-copydir-{label}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Pull the inner sync `copy_recursive` body out from
    /// `copy_directory` so the test doesn't need to spin up a
    /// tokio runtime just to exercise file-system recursion.
    /// Mirrors the same logic the async command uses.
    fn copy_dir_for_test(src: &Path, dest: &Path) -> Vec<String> {
        std::fs::create_dir_all(dest).unwrap();
        let mut out = Vec::new();
        fn rec(src: &Path, dest: &Path, files: &mut Vec<String>) {
            std::fs::create_dir_all(dest).unwrap();
            for entry in std::fs::read_dir(src).unwrap().flatten() {
                let path = entry.path();
                let name = entry.file_name();
                let dest_path = dest.join(&name);
                if name.to_string_lossy().starts_with('.') {
                    continue;
                }
                if path.is_dir() {
                    rec(&path, &dest_path, files);
                } else {
                    std::fs::copy(&path, &dest_path).unwrap();
                    files.push(dest_path.to_string_lossy().replace('\\', "/"));
                }
            }
        }
        rec(src, dest, &mut out);
        out
    }

    #[test]
    fn copy_directory_recurses_arbitrary_depth() {
        let src = make_temp_dir("src-deep");
        // Build /src/a/b/c/d/e/leaf.txt — five levels under root.
        let leaf_dir = src.join("a/b/c/d/e");
        std::fs::create_dir_all(&leaf_dir).unwrap();
        std::fs::write(leaf_dir.join("leaf.txt"), b"deep content").unwrap();
        // Plus a top-level file to ensure root files come along too.
        std::fs::write(src.join("top.md"), b"# top").unwrap();

        let dest = make_temp_dir("dest-deep");
        let copied = copy_dir_for_test(&src, &dest);

        assert_eq!(copied.len(), 2, "expected two files, got: {:?}", copied);
        // Deep file made it across with full nesting preserved.
        let leaf_dest = dest.join("a/b/c/d/e/leaf.txt");
        assert!(leaf_dest.exists(), "deep leaf.txt missing at {:?}", leaf_dest);
        assert_eq!(std::fs::read(&leaf_dest).unwrap(), b"deep content");
        // Top-level file too.
        assert!(dest.join("top.md").exists());
        // Returned paths are forward-slashed and absolute.
        for p in &copied {
            assert!(!p.contains('\\'), "path should be /-normalized: {p}");
            assert!(Path::new(p).is_absolute(), "path should be absolute: {p}");
        }

        let _ = std::fs::remove_dir_all(&src);
        let _ = std::fs::remove_dir_all(&dest);
    }

    #[test]
    fn copy_directory_skips_dotfiles_and_dot_directories() {
        let src = make_temp_dir("src-dots");
        // Visible content:
        std::fs::write(src.join("keep.md"), b"keep me").unwrap();
        std::fs::create_dir_all(src.join("subdir")).unwrap();
        std::fs::write(src.join("subdir/keep2.md"), b"keep me too").unwrap();
        // Things that must be skipped:
        std::fs::write(src.join(".DS_Store"), b"junk").unwrap();
        std::fs::create_dir_all(src.join(".git/objects")).unwrap();
        std::fs::write(src.join(".git/HEAD"), b"ref: refs/heads/main").unwrap();
        std::fs::write(src.join(".git/objects/abc"), b"\x78\x9c").unwrap();
        std::fs::write(src.join(".env"), b"SECRET=foo").unwrap();
        // Sneaky one: a dot-prefixed dir nested inside a normal dir
        // should ALSO be skipped (the dotfile rule applies at every
        // recursion level, not just the top).
        std::fs::create_dir_all(src.join("subdir/.cache")).unwrap();
        std::fs::write(src.join("subdir/.cache/blob"), b"cache").unwrap();

        let dest = make_temp_dir("dest-dots");
        let copied = copy_dir_for_test(&src, &dest);

        assert_eq!(
            copied.len(),
            2,
            "should copy only the 2 visible files, got: {:?}",
            copied,
        );
        assert!(dest.join("keep.md").exists());
        assert!(dest.join("subdir/keep2.md").exists());
        // Dot-stuff must NOT be on disk in the destination.
        assert!(!dest.join(".DS_Store").exists());
        assert!(!dest.join(".git").exists());
        assert!(!dest.join(".env").exists());
        assert!(!dest.join("subdir/.cache").exists());

        let _ = std::fs::remove_dir_all(&src);
        let _ = std::fs::remove_dir_all(&dest);
    }

    #[test]
    fn copy_directory_returns_flat_list_with_forward_slashes() {
        let src = make_temp_dir("src-flat");
        std::fs::create_dir_all(src.join("year/2024/q3")).unwrap();
        std::fs::write(src.join("year/2024/q3/report.pdf"), b"%PDF-fake").unwrap();
        std::fs::write(src.join("year/2024/notes.md"), b"# notes").unwrap();

        let dest = make_temp_dir("dest-flat");
        let copied = copy_dir_for_test(&src, &dest);

        // Both files in the flat list, ordered by file-system traversal
        // (we don't care about exact order, but every entry must be
        // forward-slashed and end with the expected filename).
        let names: Vec<String> = copied
            .iter()
            .map(|p| Path::new(p).file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert!(names.contains(&"report.pdf".to_string()));
        assert!(names.contains(&"notes.md".to_string()));
        assert_eq!(copied.len(), 2);
        for p in &copied {
            assert!(p.contains('/'), "should contain at least one /: {p}");
            assert!(!p.contains('\\'), "should NOT contain \\: {p}");
        }

        let _ = std::fs::remove_dir_all(&src);
        let _ = std::fs::remove_dir_all(&dest);
    }
}
