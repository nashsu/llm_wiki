use std::fs;
use std::io::Read as IoRead;
use std::path::Path;

use calamine::{Reader, open_workbook_auto, Data};

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
pub fn read_file(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    // Check cache first for any extractable format
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
            // Try reading as text; if it fails (binary), return a friendly message
            // Fixed: support UTF-8, UTF-16 LE/BE with BOM, and lossy fallback
            let bytes = match fs::read(&path) {
                Ok(b) => b,
                Err(e) => {
                    return Ok(format!("[Error reading file: {}]", e));
                }
            };
            let content = if bytes.len() >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF {
                // UTF-8 BOM
                String::from_utf8_lossy(&bytes[3..]).into_owned()
            } else if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
                // UTF-16 LE BOM
                let stripped: Vec<u16> = bytes[2..].chunks(2).filter_map(|c| {
                    if c.len() == 2 { Some(u16::from_le_bytes([c[0], c[1]])) } else { None }
                }).collect();
                String::from_utf16_lossy(&stripped)
            } else if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
                // UTF-16 BE BOM
                let stripped: Vec<u16> = bytes[2..].chunks(2).filter_map(|c| {
                    if c.len() == 2 { Some(u16::from_be_bytes([c[0], c[1]])) } else { None }
                }).collect();
                String::from_utf16_lossy(&stripped)
            } else {
                String::from_utf8_lossy(&bytes).into_owned()
            };
            if content.trim().is_empty() {
                let size = bytes.len() as f64;
                Ok(format!("[Empty file: {} ({:.1} KB)]",
                    p.file_name().unwrap_or_default().to_string_lossy(), size / 1024.0))
            } else {
                Ok(content)
            }
        }
    }
}

/// Pre-process a file and cache the extracted text.
#[tauri::command]
pub fn preprocess_file(path: String) -> Result<String, String> {
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

fn extract_pdf_text(path: &str) -> Result<String, String> {
    let bytes =
        fs::read(path).map_err(|e| format!("Failed to read PDF '{}': {}", path, e))?;
    pdf_extract::extract_text_from_mem(&bytes)
        .map_err(|e| format!("Failed to extract text from PDF '{}': {}", path, e))
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
                    if let docx_rs::TableChild::TableRow(tr) = row {
                        let mut cells: Vec<String> = Vec::new();
                        for cell in &tr.cells {
                            if let docx_rs::TableRowChild::TableCell(tc) = cell {
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

    // Track current paragraph state
    let mut in_paragraph = false;
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
            let tag_start = i;
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
                    in_paragraph = true;
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
                    in_paragraph = false;
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

/// Extract XLSX/XLS/ODS to Markdown tables using calamine.
fn extract_xlsx_markdown(_archive: &mut zip::ZipArchive<fs::File>) -> Result<String, String> {
    // calamine needs the file path, not the archive
    Err("Use extract_spreadsheet instead".to_string())
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
pub fn write_file(path: String, contents: String) -> Result<(), String> {
    let p = Path::new(&path);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent dirs for '{}': {}", path, e))?;
    }
    fs::write(&path, contents).map_err(|e| format!("Failed to write file '{}': {}", path, e))
}

#[tauri::command]
pub fn list_directory(path: String) -> Result<Vec<FileNode>, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("Path does not exist: '{}'", path));
    }
    if !p.is_dir() {
        return Err(format!("Path is not a directory: '{}'", path));
    }
    let nodes = build_tree(p, 0, 30)?;
    Ok(nodes)
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
        let path_str = entry_path.to_string_lossy().to_string();
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
pub fn copy_file(source: String, destination: String) -> Result<(), String> {
    let dest = Path::new(&destination);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent dirs: {}", e))?;
    }
    fs::copy(&source, &destination)
        .map_err(|e| format!("Failed to copy '{}' to '{}': {}", source, destination, e))?;
    Ok(())
}

/// Recursively copy a directory, preserving structure.
/// Returns list of copied file paths (destination paths).
#[tauri::command]
pub fn copy_directory(source: String, destination: String) -> Result<Vec<String>, String> {
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

            // Skip hidden files/dirs
            if name.to_string_lossy().starts_with('.') {
                continue;
            }

            if path.is_dir() {
                copy_recursive(&path, &dest_path, files)?;
            } else {
                fs::copy(&path, &dest_path).map_err(|e| {
                    format!("Failed to copy '{}': {}", path.display(), e)
                })?;
                files.push(dest_path.to_string_lossy().to_string());
            }
        }
        Ok(())
    }

    copy_recursive(src, dest, &mut copied_files)?;
    Ok(copied_files)
}

#[tauri::command]
pub fn delete_file(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.is_dir() {
        fs::remove_dir_all(&path)
            .map_err(|e| format!("Failed to delete directory '{}': {}", path, e))
    } else {
        fs::remove_file(&path)
            .map_err(|e| format!("Failed to delete file '{}': {}", path, e))
    }
}

/// Find wiki pages that reference a given source file name.
/// Scans all .md files under wiki/ for the source filename in frontmatter or content.
#[tauri::command]
pub fn find_related_wiki_pages(project_path: String, source_name: String) -> Result<Vec<String>, String> {
    let wiki_dir = Path::new(&project_path).join("wiki");
    if !wiki_dir.is_dir() {
        return Ok(vec![]);
    }

    let mut related = Vec::new();
    collect_related_pages(&wiki_dir, &source_name, &mut related)?;
    Ok(related)
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

                // Match 3: page was generated from this source (check frontmatter sources field)
                let frontmatter_match = if let Some(fm_start) = content.find("---\n") {
                    if let Some(fm_end) = content[fm_start + 4..].find("\n---") {
                        let frontmatter = &content[fm_start..fm_start + 4 + fm_end].to_lowercase();
                        frontmatter.contains("sources:")
                            && frontmatter.contains(&file_name_lower)
                    } else {
                        false
                    }
                } else {
                    false
                };

                if sources_match || is_source_summary || frontmatter_match {
                    results.push(path.to_string_lossy().to_string());
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn create_directory(path: String) -> Result<(), String> {
    fs::create_dir_all(&path)
        .map_err(|e| format!("Failed to create directory '{}': {}", path, e))
}
