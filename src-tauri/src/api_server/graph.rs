use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use serde::Serialize;
use serde_json::json;
use tauri::AppHandle;
use walkdir::WalkDir;

use crate::commands;

use super::common::{err, ok, parse_query, ApiResponse};
use super::projects::resolve_project;
use super::relative_to_project;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiGraphNode {
    id: String,
    label: String,
    node_type: String,
    path: String,
    link_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiGraphEdge {
    source: String,
    target: String,
    weight: f64,
}

pub(super) fn handle_graph(app: &AppHandle, project_id: &str, query: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(error) => return err(404, error),
    };
    let params = parse_query(query);
    let q = params.get("q").map(|value| value.to_lowercase());
    let node_type = params.get("nodeType").map(|value| value.to_lowercase());
    let limit = params
        .get("limit")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(200)
        .clamp(1, 1000);

    match build_graph(&project.path) {
        Ok((mut nodes, edges)) => {
            if let Some(ref q) = q {
                nodes.retain(|node| {
                    node.id.to_lowercase().contains(q) || node.label.to_lowercase().contains(q)
                });
            }
            if let Some(ref node_type) = node_type {
                nodes.retain(|node| node.node_type == *node_type);
            }
            nodes.truncate(limit);
            let ids: BTreeSet<String> = nodes.iter().map(|node| node.id.clone()).collect();
            let edges: Vec<ApiGraphEdge> = edges
                .into_iter()
                .filter(|edge| ids.contains(&edge.source) && ids.contains(&edge.target))
                .collect();
            ok(json!({ "ok": true, "projectId": project.id, "nodes": nodes, "edges": edges }))
        }
        Err(error) => err(500, error),
    }
}

fn build_graph(project_path: &str) -> Result<(Vec<ApiGraphNode>, Vec<ApiGraphEdge>), String> {
    let wiki_root = Path::new(project_path).join("wiki");
    let mut raw: BTreeMap<String, (String, String, String, Vec<String>)> = BTreeMap::new();
    for entry in WalkDir::new(&wiki_root).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file()
            || entry.path().extension().and_then(|value| value.to_str()) != Some("md")
        {
            continue;
        }
        let content = match fs::read_to_string(entry.path()) {
            Ok(content) => content,
            Err(_) => continue,
        };
        let id = entry
            .path()
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_string();
        if id.is_empty() {
            continue;
        }
        let title =
            commands::search::extract_title(&content, entry.file_name().to_string_lossy().as_ref());
        let node_type = extract_type(&content);
        let path = relative_to_project(project_path, entry.path());
        let links = extract_wikilinks(&content);
        raw.insert(id, (title, node_type, path, links));
    }
    let ids: BTreeSet<String> = raw.keys().cloned().collect();
    let mut link_count: BTreeMap<String, usize> = raw.keys().map(|id| (id.clone(), 0)).collect();
    let mut seen = BTreeSet::new();
    let mut edges = Vec::new();
    for (source, (_, _, _, links)) in &raw {
        for link in links {
            let Some(target) = resolve_link(link, &ids) else {
                continue;
            };
            if &target == source {
                continue;
            }
            let key = if source < &target {
                format!("{source}::{target}")
            } else {
                format!("{target}::{source}")
            };
            if seen.insert(key) {
                *link_count.entry(source.clone()).or_default() += 1;
                *link_count.entry(target.clone()).or_default() += 1;
                edges.push(ApiGraphEdge {
                    source: source.clone(),
                    target,
                    weight: 1.0,
                });
            }
        }
    }
    let nodes = raw
        .into_iter()
        .filter(|(_, (_, node_type, _, _))| node_type != "query")
        .map(|(id, (label, node_type, path, _))| ApiGraphNode {
            link_count: *link_count.get(&id).unwrap_or(&0),
            id,
            label,
            node_type,
            path,
        })
        .collect();
    Ok((nodes, edges))
}

fn extract_type(content: &str) -> String {
    for line in content.lines() {
        if let Some(value) = line.trim().strip_prefix("type:") {
            return value
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .to_lowercase();
        }
    }
    "other".to_string()
}

fn extract_wikilinks(content: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = content;
    while let Some(start) = rest.find("[[") {
        rest = &rest[start + 2..];
        let Some(end) = rest.find("]]") else {
            break;
        };
        let inner = &rest[..end];
        let target = inner.split('|').next().unwrap_or("").trim();
        if !target.is_empty() {
            out.push(target.to_string());
        }
        rest = &rest[end + 2..];
    }
    out
}

fn resolve_link(raw: &str, ids: &BTreeSet<String>) -> Option<String> {
    if ids.contains(raw) {
        return Some(raw.to_string());
    }
    let normalized = raw.to_lowercase().replace(' ', "-");
    ids.iter()
        .find(|id| id.to_lowercase() == normalized || id.to_lowercase() == raw.to_lowercase())
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_type_reads_frontmatter_type_and_defaults_to_other() {
        let typed = "---\ntype: Concept\n---\n# Title";
        assert_eq!(extract_type(typed), "concept");

        let missing = "# Title\nBody";
        assert_eq!(extract_type(missing), "other");
    }

    #[test]
    fn extract_wikilinks_collects_targets_and_ignores_aliases() {
        let content = "See [[Attention Is All You Need|paper]] and [[knowledge-graph]].";
        assert_eq!(
            extract_wikilinks(content),
            vec![
                "Attention Is All You Need".to_string(),
                "knowledge-graph".to_string()
            ]
        );
    }

    #[test]
    fn resolve_link_matches_exact_and_normalized_forms() {
        let ids = BTreeSet::from([
            "attention-is-all-you-need".to_string(),
            "knowledge-graph".to_string(),
        ]);

        assert_eq!(
            resolve_link("knowledge-graph", &ids).as_deref(),
            Some("knowledge-graph")
        );
        assert_eq!(
            resolve_link("Attention Is All You Need", &ids).as_deref(),
            Some("attention-is-all-you-need")
        );
        assert_eq!(resolve_link("missing", &ids), None);
    }
}
