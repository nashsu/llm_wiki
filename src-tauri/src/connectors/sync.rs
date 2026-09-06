//! The shared sync engine: listing → diff against saved state → files under
//! `raw/sources/@<instance>/…` → source-watch rescan so the frontend ingests.
//!
//! The engine is the only place that knows about the project layout; a
//! connector never sees a local path. Deletions are applied as plain file
//! removals — the existing "external delete" handling (cascade cleanup of
//! summary pages, `sources[]` frontmatter, wikilinks) then runs unchanged.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use serde_json::json;

use super::store::{self, ItemState};
use super::{
    build, instance_folder_name, now_ms, ConnectorInstance, RemoteItem, SkipReason, SyncSummary,
};
use crate::app_ctx::AppCtx;

const SOURCES_DIR: &str = "raw/sources";
const DEFAULT_MAX_FILE_SIZE_MB: u64 = 100;
/// Emit a progress event at most every N processed items.
const PROGRESS_EVERY: usize = 10;
pub const EVENT_SYNC: &str = "connectors://sync";

/// Instances currently syncing (`"<project_id>:<instance_id>"`).
fn running() -> &'static Mutex<HashSet<String>> {
    static RUNNING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(HashSet::new()))
}

pub fn is_running(project_id: &str, instance_id: &str) -> bool {
    running()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .contains(&format!("{project_id}:{instance_id}"))
}

struct RunGuard(String);

impl RunGuard {
    fn acquire(project_id: &str, instance_id: &str) -> Option<Self> {
        let key = format!("{project_id}:{instance_id}");
        let mut set = running().lock().unwrap_or_else(|p| p.into_inner());
        if set.contains(&key) {
            return None;
        }
        set.insert(key.clone());
        Some(Self(key))
    }
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        running()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&self.0);
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedItem {
    pub name: String,
    pub reason: SkipReason,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub summary: SyncSummary,
    pub added: Vec<String>,
    pub updated: Vec<String>,
    pub deleted: Vec<String>,
    pub skipped: Vec<SkippedItem>,
}

fn emit(ctx: &AppCtx, project_id: &str, instance_id: &str, phase: &str, extra: serde_json::Value) {
    let mut payload = json!({
        "projectId": project_id,
        "instanceId": instance_id,
        "phase": phase,
    });
    if let (Some(map), Some(extra_map)) = (payload.as_object_mut(), extra.as_object()) {
        for (k, v) in extra_map {
            map.insert(k.clone(), v.clone());
        }
    }
    let _ = ctx.emit(EVENT_SYNC, payload);
}

/// Path components that are safe to join under the project: no separators,
/// no `..`, no control characters, no leading/trailing dots or spaces.
fn sanitize_component(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .chars()
        .filter(|c| !c.is_control())
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            other => other,
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        None
    } else {
        Some(cleaned)
    }
}

fn ingestable(name: &str) -> bool {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    if ext.is_empty() || ext == name.to_ascii_lowercase() {
        return false;
    }
    let include = crate::commands::file_sync::default_source_watch_include_extensions();
    let exclude = crate::commands::file_sync::default_source_watch_exclude_extensions();
    !exclude.iter().any(|e| e == &ext) && include.iter().any(|e| e == &ext)
}

/// Where an item is stored, relative to the project root.
fn local_relative_path(root_folder: &str, item: &RemoteItem, file_name: &str) -> Option<String> {
    let mut parts: Vec<String> = vec![SOURCES_DIR.to_string(), root_folder.to_string()];
    let dirs = if item.path.is_empty() {
        &[][..]
    } else {
        &item.path[..item.path.len() - 1]
    };
    for dir in dirs {
        parts.push(sanitize_component(dir)?);
    }
    parts.push(sanitize_component(file_name)?);
    Some(parts.join("/"))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    let tmp = path.with_extension(format!(
        "{}.llmwiki-tmp",
        path.extension().and_then(|e| e.to_str()).unwrap_or("bin")
    ));
    fs::write(&tmp, bytes).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("cannot replace {}: {e}", path.display()))
}

fn remove_local(project_path: &Path, rel: &str) {
    let full = project_path.join(rel);
    if full.is_file() {
        let _ = fs::remove_file(&full);
    }
    // Prune now-empty directories up to the instance folder.
    let mut dir = full.parent().map(Path::to_path_buf);
    while let Some(d) = dir {
        if !d.starts_with(project_path.join(SOURCES_DIR)) || d == project_path.join(SOURCES_DIR) {
            break;
        }
        let empty = fs::read_dir(&d)
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(false);
        if !empty {
            break;
        }
        let _ = fs::remove_dir(&d);
        dir = d.parent().map(Path::to_path_buf);
    }
}

/// Run one sync for `instance` in `project`. Returns the report; the same
/// summary is persisted on the instance and broadcast as events.
pub async fn run_sync(
    ctx: &AppCtx,
    project_id: &str,
    project_path: &Path,
    instance_id: &str,
) -> Result<SyncReport, String> {
    let Some(_guard) = RunGuard::acquire(project_id, instance_id) else {
        return Err("A sync for this connector is already running".to_string());
    };
    let instance = store::get_instance(project_path, instance_id)
        .ok_or_else(|| format!("Unknown connector instance: {instance_id}"))?;
    let secrets = store::load_secrets(ctx, instance_id);
    let connector = build(ctx, &instance, &secrets)?;
    let started_at = now_ms();
    emit(ctx, project_id, instance_id, "started", json!({ "name": instance.name }));

    let result = run_inner(ctx, project_id, project_path, &instance, connector.as_ref()).await;

    let mut report = match result {
        Ok(report) => report,
        Err(err) => SyncReport {
            summary: SyncSummary {
                errors: vec![err],
                ..Default::default()
            },
            ..Default::default()
        },
    };
    report.summary.started_at = started_at;
    report.summary.finished_at = now_ms();
    report.summary.ok = report.summary.errors.is_empty();
    let _ = store::record_sync_summary(project_path, instance_id, report.summary.clone());

    // No explicit rescan here: connector writes are ordinary filesystem
    // changes (never marked as app writes), so the project's source-folder
    // watcher sees them while a UI is attached, and the startup rescan of
    // the next project open picks them up otherwise. Forcing a rescan with
    // no UI listening would update the snapshot without anything being
    // queued for ingest.

    emit(
        ctx,
        project_id,
        instance_id,
        if report.summary.ok { "finished" } else { "failed" },
        json!({ "report": report }),
    );
    Ok(report)
}

async fn run_inner(
    ctx: &AppCtx,
    project_id: &str,
    project_path: &Path,
    instance: &ConnectorInstance,
    connector: &dyn super::Connector,
) -> Result<SyncReport, String> {
    let mut state = store::load_state(project_path, &instance.id);
    let root_folder = instance_folder_name(instance);
    let max_bytes = if instance.max_file_size_mb > 0 {
        instance.max_file_size_mb
    } else {
        DEFAULT_MAX_FILE_SIZE_MB
    } * 1024
        * 1024;

    let listing = connector.list_all(state.cursor.as_deref()).await?;
    let mut report = SyncReport::default();
    let total = listing.items.len();
    emit(ctx, project_id, &instance.id, "listed", json!({ "total": total, "delta": listing.is_delta }));

    // Full snapshots: anything we had that is no longer listed is gone.
    let mut seen: HashSet<String> = HashSet::new();
    let mut next_items: BTreeMap<String, ItemState> = state.items.clone();

    for (index, item) in listing.items.iter().enumerate() {
        if index % PROGRESS_EVERY == 0 {
            emit(
                ctx,
                project_id,
                &instance.id,
                "progress",
                json!({ "done": index, "total": total }),
            );
        }
        if item.is_dir {
            continue;
        }
        seen.insert(item.id.clone());

        if item.deleted {
            if let Some(prev) = next_items.remove(&item.id) {
                remove_local(project_path, &prev.local_path);
                report.deleted.push(prev.local_path);
            }
            continue;
        }

        if !ingestable(&item.name) && !looks_like_google_doc(item) {
            report.skipped.push(SkippedItem {
                name: item.name.clone(),
                reason: SkipReason::UnsupportedType,
                detail: None,
            });
            continue;
        }
        if item.size.is_some_and(|s| s > max_bytes) {
            report.skipped.push(SkippedItem {
                name: item.name.clone(),
                reason: SkipReason::TooLarge,
                detail: item.size.map(|s| format!("{:.1} MB", s as f64 / 1_048_576.0)),
            });
            continue;
        }

        if let Some(prev) = next_items.get(&item.id) {
            if prev.version == item.version && project_path.join(&prev.local_path).is_file() {
                report.summary.unchanged += 1;
                continue;
            }
        }

        let fetched = match connector.fetch(item).await {
            Ok(f) => f,
            Err(err) => {
                report.skipped.push(SkippedItem {
                    name: item.name.clone(),
                    reason: SkipReason::FetchFailed,
                    detail: Some(err),
                });
                continue;
            }
        };
        if fetched.bytes.len() as u64 > max_bytes {
            report.skipped.push(SkippedItem {
                name: item.name.clone(),
                reason: SkipReason::TooLarge,
                detail: Some(format!("{:.1} MB", fetched.bytes.len() as f64 / 1_048_576.0)),
            });
            continue;
        }
        if !ingestable(&fetched.file_name) {
            report.skipped.push(SkippedItem {
                name: fetched.file_name.clone(),
                reason: SkipReason::UnsupportedType,
                detail: None,
            });
            continue;
        }
        let Some(rel) = local_relative_path(&root_folder, item, &fetched.file_name) else {
            report.skipped.push(SkippedItem {
                name: item.name.clone(),
                reason: SkipReason::Excluded,
                detail: Some("unsafe path".into()),
            });
            continue;
        };
        // A rename on the remote moves the file locally too.
        let previous = next_items.get(&item.id).cloned();
        if let Some(prev) = &previous {
            if prev.local_path != rel {
                remove_local(project_path, &prev.local_path);
            }
        }
        if let Err(err) = write_atomic(&project_path.join(&rel), &fetched.bytes) {
            report.skipped.push(SkippedItem {
                name: item.name.clone(),
                reason: SkipReason::WriteFailed,
                detail: Some(err),
            });
            continue;
        }
        next_items.insert(
            item.id.clone(),
            ItemState {
                version: item.version.clone(),
                local_path: rel.clone(),
                remote_path: item.path.clone(),
            },
        );
        if previous.is_some() {
            report.updated.push(rel);
        } else {
            report.added.push(rel);
        }
    }

    if !listing.is_delta {
        let stale: Vec<String> = next_items
            .keys()
            .filter(|id| !seen.contains(*id))
            .cloned()
            .collect();
        for id in stale {
            if let Some(prev) = next_items.remove(&id) {
                remove_local(project_path, &prev.local_path);
                report.deleted.push(prev.local_path);
            }
        }
    }

    state.items = next_items;
    state.cursor = listing.next_cursor.or(if listing.is_delta { state.cursor.clone() } else { None });
    store::save_state(project_path, &instance.id, &state)?;

    report.summary.added = report.added.len();
    report.summary.updated = report.updated.len();
    report.summary.deleted = report.deleted.len();
    report.summary.skipped = report.skipped.len();
    Ok(report)
}

/// Google-native documents have no extension until export; let them through
/// the pre-fetch filter and judge the exported name instead.
fn looks_like_google_doc(item: &RemoteItem) -> bool {
    item.mime
        .as_deref()
        .is_some_and(|m| m.starts_with("application/vnd.google-apps."))
}

/// Remove everything an instance synced (used when deleting the instance).
pub fn purge_instance_files(project_path: &Path, instance: &ConnectorInstance) -> usize {
    let state = store::load_state(project_path, &instance.id);
    let mut removed = 0;
    for item in state.items.values() {
        let full = project_path.join(&item.local_path);
        if full.is_file() && fs::remove_file(&full).is_ok() {
            removed += 1;
        }
    }
    let folder: PathBuf = project_path.join(SOURCES_DIR).join(instance_folder_name(instance));
    let _ = fs::remove_dir_all(folder);
    removed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connectors::{Connector, Fetched, Listing};
    use async_trait::async_trait;
    use serde_json::Map;

    struct FakeConnector {
        items: Vec<RemoteItem>,
        delta: bool,
    }

    #[async_trait]
    impl Connector for FakeConnector {
        fn kind(&self) -> &'static str {
            "fake"
        }
        async fn test(&self) -> Result<String, String> {
            Ok("ok".into())
        }
        async fn list_all(&self, _cursor: Option<&str>) -> Result<Listing, String> {
            Ok(Listing {
                items: self.items.clone(),
                is_delta: self.delta,
                next_cursor: None,
            })
        }
        async fn fetch(&self, item: &RemoteItem) -> Result<Fetched, String> {
            Ok(Fetched {
                bytes: format!("content of {}", item.name).into_bytes(),
                file_name: item.name.clone(),
            })
        }
    }

    fn item(id: &str, path: &[&str], version: &str) -> RemoteItem {
        RemoteItem {
            id: id.into(),
            path: path.iter().map(|s| s.to_string()).collect(),
            name: path.last().unwrap().to_string(),
            mime: None,
            size: Some(10),
            modified: None,
            version: version.into(),
            deleted: false,
            is_dir: false,
        }
    }

    fn setup() -> (AppCtx, PathBuf, ConnectorInstance) {
        let base = std::env::temp_dir().join(format!("llm-wiki-sync-{}", uuid::Uuid::new_v4()));
        let project = base.join("project");
        fs::create_dir_all(project.join("raw/sources")).unwrap();
        let ctx = AppCtx::headless(base.join("data"), None);
        let instance = ConnectorInstance {
            id: "inst".into(),
            kind: "fake".into(),
            name: "Fake".into(),
            enabled: true,
            interval_minutes: 0,
            config: Map::new(),
            max_file_size_mb: 0,
            created_at: 0,
            last_sync: None,
        };
        store::upsert_instance(&project, instance.clone()).unwrap();
        (ctx, project, instance)
    }

    #[test]
    fn snapshot_sync_adds_updates_and_deletes() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let (ctx, project, instance) = setup();
        let first = FakeConnector {
            items: vec![item("a", &["docs", "one.md"], "v1"), item("b", &["two.txt"], "v1")],
            delta: false,
        };
        let r1 = rt
            .block_on(run_inner(&ctx, "p", &project, &instance, &first))
            .unwrap();
        assert_eq!(r1.added.len(), 2);
        assert!(project.join("raw/sources/@Fake/docs/one.md").is_file());

        let second = FakeConnector {
            items: vec![item("a", &["docs", "one.md"], "v2")], // b gone, a changed
            delta: false,
        };
        let r2 = rt
            .block_on(run_inner(&ctx, "p", &project, &instance, &second))
            .unwrap();
        assert_eq!(r2.updated, vec!["raw/sources/@Fake/docs/one.md"]);
        assert_eq!(r2.deleted, vec!["raw/sources/@Fake/two.txt"]);
        assert!(!project.join("raw/sources/@Fake/two.txt").exists());

        let third = FakeConnector {
            items: vec![item("a", &["docs", "one.md"], "v2")],
            delta: false,
        };
        let r3 = rt
            .block_on(run_inner(&ctx, "p", &project, &instance, &third))
            .unwrap();
        assert_eq!(r3.summary.unchanged, 1);
        let _ = fs::remove_dir_all(project.parent().unwrap());
    }

    #[test]
    fn delta_listing_only_touches_reported_items() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let (ctx, project, instance) = setup();
        let full = FakeConnector {
            items: vec![item("a", &["a.md"], "v1"), item("b", &["b.md"], "v1")],
            delta: false,
        };
        rt.block_on(run_inner(&ctx, "p", &project, &instance, &full)).unwrap();
        let mut removed = item("b", &["b.md"], "v1");
        removed.deleted = true;
        let delta = FakeConnector {
            items: vec![removed],
            delta: true,
        };
        let r = rt.block_on(run_inner(&ctx, "p", &project, &instance, &delta)).unwrap();
        assert_eq!(r.deleted.len(), 1);
        assert!(project.join("raw/sources/@Fake/a.md").is_file());
        let _ = fs::remove_dir_all(project.parent().unwrap());
    }

    #[test]
    fn unsupported_and_unsafe_paths_are_skipped() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let (ctx, project, instance) = setup();
        let c = FakeConnector {
            items: vec![item("x", &["..", "evil.md"], "v1"), item("y", &["photo.exe"], "v1")],
            delta: false,
        };
        let r = rt.block_on(run_inner(&ctx, "p", &project, &instance, &c)).unwrap();
        assert_eq!(r.added.len(), 0);
        assert_eq!(r.skipped.len(), 2);
        let _ = fs::remove_dir_all(project.parent().unwrap());
    }
}
