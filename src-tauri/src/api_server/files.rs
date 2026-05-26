use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;
use serde_json::json;
use tauri::AppHandle;

use super::common::{err, ok, parse_query, ApiResponse};
use super::projects::resolve_project;
use super::{relative_to_project, DEFAULT_MAX_FILES, HARD_MAX_FILES, MAX_FILE_CONTENT_BYTES};

pub(super) fn handle_files(app: &AppHandle, project_id: &str, query: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(error) => return err(404, error),
    };
    let params = parse_query(query);
    let root = params.get("root").map(String::as_str).unwrap_or("wiki");
    let recursive = params
        .get("recursive")
        .map(|value| value != "false")
        .unwrap_or(true);
    let max_files = params
        .get("maxFiles")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(DEFAULT_MAX_FILES)
        .clamp(1, HARD_MAX_FILES);
    let rel = match root {
        "wiki" => "wiki",
        "sources" | "raw" | "raw/sources" => "raw/sources",
        "all" | "" => "",
        _ => return err(400, "root must be wiki, sources, or all"),
    };
    if rel.is_empty() {
        return match list_public_roots(&project.path, recursive, max_files) {
            Ok(files) => ok(json!({
                "ok": true,
                "projectId": project.id,
                "root": "all",
                "files": files,
                "truncated": false,
            })),
            Err(error) => err(if error.contains("exceeds") { 413 } else { 500 }, error),
        };
    }
    let dir = match safe_join(&project.path, rel) {
        Ok(path) => path,
        Err(error) => return err(400, error),
    };
    let mut count = 0;
    match list_tree(&project.path, &dir, recursive, max_files, &mut count) {
        Ok(files) => ok(json!({
            "ok": true,
            "projectId": project.id,
            "root": rel,
            "files": files,
            "truncated": false,
        })),
        Err(error) => err(if error.contains("exceeds") { 413 } else { 500 }, error),
    }
}

pub(super) fn handle_file_content(app: &AppHandle, project_id: &str, query: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(error) => return err(404, error),
    };
    let params = parse_query(query);
    let Some(rel) = params.get("path") else {
        return err(400, "Missing path query parameter");
    };
    if !is_public_project_rel(rel) {
        return err(403, "Path is not exposed by the local API");
    }
    if !is_text_content_rel(rel) {
        return err(
            415,
            "Only text-like project files can be read via this endpoint",
        );
    }
    let path = match safe_join(&project.path, rel) {
        Ok(path) => path,
        Err(error) => return err(400, error),
    };
    let meta = match fs::metadata(&path) {
        Ok(meta) => meta,
        Err(error) => return err(404, format!("File not found: {error}")),
    };
    if meta.len() > MAX_FILE_CONTENT_BYTES {
        return err(413, "File is too large to return via API");
    }
    match fs::read_to_string(&path) {
        Ok(content) => ok(json!({
            "ok": true,
            "projectId": project.id,
            "path": rel,
            "content": content,
        })),
        Err(_) => err(415, "File is not valid UTF-8 text"),
    }
}

pub(super) fn safe_join(project_path: &str, rel: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(project_path);
    let rel = rel.trim_start_matches('/');
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() {
        return Err("Absolute paths are not allowed".to_string());
    }
    for component in rel_path.components() {
        if matches!(
            component,
            Component::ParentDir | Component::Prefix(_) | Component::RootDir
        ) {
            return Err("Path traversal is not allowed".to_string());
        }
    }
    let joined = root.join(rel_path);
    let root_canon = root
        .canonicalize()
        .map_err(|error| format!("Failed to resolve project path: {error}"))?;
    if joined.exists() {
        let joined_canon = joined
            .canonicalize()
            .map_err(|error| format!("Failed to resolve path: {error}"))?;
        if !joined_canon.starts_with(&root_canon) {
            return Err("Resolved path escapes the project directory".to_string());
        }
        return Ok(joined_canon);
    }
    let parent = joined
        .parent()
        .ok_or_else(|| "Path has no parent directory".to_string())?;
    if parent.exists() {
        let parent_canon = parent
            .canonicalize()
            .map_err(|error| format!("Failed to resolve parent path: {error}"))?;
        if !parent_canon.starts_with(&root_canon) {
            return Err("Resolved parent escapes the project directory".to_string());
        }
    }
    Ok(joined)
}

pub(super) fn is_public_project_rel(rel: &str) -> bool {
    let rel = super::normalize_path(rel)
        .trim_start_matches('/')
        .to_string();
    if rel
        .split('/')
        .any(|part| part.is_empty() || part.starts_with('.'))
    {
        return false;
    }
    let lower = rel.to_lowercase();
    lower == "purpose.md"
        || lower == "schema.md"
        || lower.starts_with("wiki/")
        || lower.starts_with("raw/sources/")
}

pub(super) fn is_text_content_rel(rel: &str) -> bool {
    let rel = super::normalize_path(rel).to_lowercase();
    let ext = Path::new(&rel)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    matches!(
        ext,
        "md" | "mdx"
            | "txt"
            | "csv"
            | "json"
            | "yaml"
            | "yml"
            | "xml"
            | "html"
            | "htm"
            | "rtf"
            | "log"
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiFileNode {
    name: String,
    path: String,
    is_dir: bool,
    size: Option<u64>,
    children: Option<Vec<ApiFileNode>>,
}

fn list_public_roots(
    project_path: &str,
    recursive: bool,
    max_files: usize,
) -> Result<Vec<ApiFileNode>, String> {
    let mut count = 0;
    let mut roots = Vec::new();
    for rel in ["purpose.md", "schema.md", "wiki", "raw/sources"] {
        let path = safe_join(project_path, rel)?;
        if !path.exists() {
            continue;
        }
        push_file_node(
            project_path,
            &path,
            recursive,
            max_files,
            &mut count,
            &mut roots,
        )?;
    }
    Ok(roots)
}

fn list_tree(
    project_path: &str,
    path: &Path,
    recursive: bool,
    max_files: usize,
    count: &mut usize,
) -> Result<Vec<ApiFileNode>, String> {
    let mut out = Vec::new();
    let entries =
        fs::read_dir(path).map_err(|error| format!("Failed to list directory: {error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("Failed to read directory entry: {error}"))?;
        push_file_node(
            project_path,
            &entry.path(),
            recursive,
            max_files,
            count,
            &mut out,
        )?;
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

fn push_file_node(
    project_path: &str,
    path: &Path,
    recursive: bool,
    max_files: usize,
    count: &mut usize,
    out: &mut Vec<ApiFileNode>,
) -> Result<(), String> {
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    if name.starts_with('.') {
        return Ok(());
    }
    let meta =
        fs::symlink_metadata(path).map_err(|error| format!("Failed to read metadata: {error}"))?;
    let file_type = meta.file_type();
    if file_type.is_symlink() {
        return Ok(());
    }
    *count += 1;
    if *count > max_files {
        return Err(format!("File listing exceeds maxFiles limit ({max_files})"));
    }
    let is_dir = file_type.is_dir();
    let children = if recursive && is_dir {
        Some(list_tree(project_path, path, true, max_files, count)?)
    } else {
        None
    };
    out.push(ApiFileNode {
        name,
        path: relative_to_project(project_path, path),
        is_dir,
        size: if is_dir { None } else { Some(meta.len()) },
        children,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_ID: AtomicUsize = AtomicUsize::new(0);

    fn temp_project_root() -> PathBuf {
        let time_id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let seq = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!("llm-wiki-files-test-{time_id}-{seq}"));
        fs::create_dir_all(root.join("wiki")).unwrap();
        root
    }

    #[test]
    fn list_tree_sorts_directories_before_files_and_hides_dot_entries() {
        let root = temp_project_root();
        fs::create_dir_all(root.join("wiki/z-dir")).unwrap();
        fs::write(root.join("wiki/b.md"), "b").unwrap();
        fs::write(root.join("wiki/a.md"), "a").unwrap();
        fs::write(root.join("wiki/.draft.md"), "hidden").unwrap();

        let mut count = 0;
        let nodes = list_tree(
            &root.to_string_lossy(),
            &root.join("wiki"),
            false,
            20,
            &mut count,
        )
        .unwrap();

        let names: Vec<&str> = nodes.iter().map(|node| node.name.as_str()).collect();
        assert_eq!(names, vec!["z-dir", "a.md", "b.md"]);
        assert!(nodes[0].is_dir);
        assert!(nodes.iter().all(|node| node.name != ".draft.md"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn list_public_roots_only_returns_existing_public_roots() {
        let root = temp_project_root();
        fs::write(root.join("purpose.md"), "purpose").unwrap();
        fs::create_dir_all(root.join("raw/sources")).unwrap();
        fs::write(root.join("raw/sources/source.md"), "source").unwrap();
        fs::write(root.join("wiki/index.md"), "index").unwrap();

        let nodes = list_public_roots(&root.to_string_lossy(), true, 20).unwrap();
        let paths: Vec<&str> = nodes.iter().map(|node| node.path.as_str()).collect();

        assert_eq!(paths, vec!["purpose.md", "wiki", "raw/sources"]);
        assert!(!paths.contains(&"schema.md"));

        let wiki = nodes.iter().find(|node| node.path == "wiki").unwrap();
        let wiki_children = wiki.children.as_ref().unwrap();
        assert_eq!(wiki_children.len(), 1);
        assert_eq!(wiki_children[0].path, "wiki/index.md");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn list_public_roots_enforces_max_files_limit() {
        let root = temp_project_root();
        fs::write(root.join("purpose.md"), "purpose").unwrap();
        fs::write(root.join("schema.md"), "schema").unwrap();
        fs::write(root.join("wiki/index.md"), "index").unwrap();

        let error = match list_public_roots(&root.to_string_lossy(), true, 2) {
            Ok(_) => panic!("expected maxFiles limit error"),
            Err(error) => error,
        };
        assert!(error.contains("maxFiles"));

        let _ = fs::remove_dir_all(root);
    }
}
