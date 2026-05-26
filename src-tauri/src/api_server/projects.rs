use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::clip_server;

use super::auth::load_app_state;
use super::common::{ok, percent_decode, ApiResponse};
use super::normalize_path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct ProjectEntry {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) path: String,
    pub(super) current: bool,
}

pub(super) fn handle_projects(app: &AppHandle) -> ApiResponse {
    let projects = load_projects(app);
    let current_project = projects.iter().find(|project| project.current).cloned();
    ok(json!({
        "ok": true,
        "projects": projects,
        "currentProject": current_project,
    }))
}

pub(super) fn load_projects(app: &AppHandle) -> Vec<ProjectEntry> {
    let current = normalize_path(&clip_server::current_project_path());
    let mut by_path: BTreeMap<String, ProjectEntry> = BTreeMap::new();

    if let Some(parsed) = load_app_state(app) {
        if let Some(registry) = parsed.get("projectRegistry").and_then(Value::as_object) {
            for (id, value) in registry {
                let path = value.get("path").and_then(Value::as_str).unwrap_or("");
                if path.is_empty() {
                    continue;
                }
                let path = normalize_path(path);
                let name = value
                    .get("name")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
                    .unwrap_or_else(|| project_name_from_path(&path));
                by_path.insert(
                    path.clone(),
                    ProjectEntry {
                        id: id.clone(),
                        name,
                        current: path == current,
                        path,
                    },
                );
            }
        }
        if let Some(recents) = parsed.get("recentProjects").and_then(Value::as_array) {
            for value in recents {
                let path = value.get("path").and_then(Value::as_str).unwrap_or("");
                if path.is_empty() {
                    continue;
                }
                let path = normalize_path(path);
                by_path.entry(path.clone()).or_insert_with(|| {
                    let id = read_project_id(&path).unwrap_or_else(|| path.clone());
                    let name = value
                        .get("name")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                        .unwrap_or_else(|| project_name_from_path(&path));
                    ProjectEntry {
                        id,
                        name,
                        current: path == current,
                        path,
                    }
                });
            }
        }
    }

    for (name, path) in clip_server::all_projects() {
        let path = normalize_path(&path);
        by_path.entry(path.clone()).or_insert_with(|| ProjectEntry {
            id: read_project_id(&path).unwrap_or_else(|| path.clone()),
            name: if name.is_empty() {
                project_name_from_path(&path)
            } else {
                name
            },
            current: path == current,
            path,
        });
    }

    if !current.is_empty() {
        by_path
            .entry(current.clone())
            .or_insert_with(|| ProjectEntry {
                id: read_project_id(&current).unwrap_or_else(|| current.clone()),
                name: project_name_from_path(&current),
                current: true,
                path: current.clone(),
            });
    }

    by_path.into_values().collect()
}

pub(super) fn resolve_project(app: &AppHandle, project_id: &str) -> Result<ProjectEntry, String> {
    let project_id = percent_decode(project_id);
    let wants_current = project_id.eq_ignore_ascii_case("current");
    load_projects(app)
        .into_iter()
        .find(|project| {
            project.id == project_id
                || project_path_matches(&project.path, &project_id)
                || (wants_current && project.current)
        })
        .ok_or_else(|| format!("Unknown project: {project_id}"))
}

pub(super) fn project_path_matches(stored_path: &str, candidate: &str) -> bool {
    let stored = normalize_path(stored_path);
    let candidate = normalize_path(candidate);
    if cfg!(windows) {
        stored.eq_ignore_ascii_case(&candidate)
    } else {
        stored == candidate
    }
}

fn read_project_id(path: &str) -> Option<String> {
    let raw = fs::read_to_string(Path::new(path).join(".llm-wiki/project.json")).ok()?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    parsed
        .get("id")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn project_name_from_path(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("Project")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_project_root() -> std::path::PathBuf {
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("llm-wiki-projects-test-{id}"))
    }

    #[test]
    fn read_project_id_reads_llm_wiki_project_metadata() {
        let root = temp_project_root();
        fs::create_dir_all(root.join(".llm-wiki")).unwrap();
        fs::write(
            root.join(".llm-wiki/project.json"),
            r#"{ "id": "project-123" }"#,
        )
        .unwrap();

        let root_str = root.to_string_lossy().to_string();
        assert_eq!(read_project_id(&root_str).as_deref(), Some("project-123"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn project_name_from_path_uses_last_path_segment_or_fallback() {
        assert_eq!(project_name_from_path("/tmp/my-wiki"), "my-wiki");
        assert_eq!(project_name_from_path(""), "Project");
    }
}
