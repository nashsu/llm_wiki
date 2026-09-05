//! Persistence for connector instances, per-instance sync state, and secrets.
//!
//! * `<project>/.llm-wiki/connectors.json` — the instances (config, schedule,
//!   last sync summary). Lives with the project so it travels with exports.
//! * `<project>/.llm-wiki/connectors/<id>.state.json` — what the engine last
//!   saw: sync cursor + one entry per synced remote item.
//! * `<app data>/connectors-secrets.json` — OAuth tokens and client secrets
//!   for every instance, keyed by instance id. Deliberately outside the
//!   project folder (which is often a git repo / Obsidian vault) and, on
//!   Unix, created with mode 0600.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::{ConnectorInstance, Secrets};
use crate::app_ctx::AppCtx;

static INSTANCES_LOCK: Mutex<()> = Mutex::new(());
static SECRETS_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstancesFile {
    #[serde(default)]
    instances: Vec<ConnectorInstance>,
}

fn instances_path(project_path: &Path) -> PathBuf {
    project_path.join(".llm-wiki").join("connectors.json")
}

fn state_dir(project_path: &Path) -> PathBuf {
    project_path.join(".llm-wiki").join("connectors")
}

fn state_path(project_path: &Path, instance_id: &str) -> PathBuf {
    state_dir(project_path).join(format!("{instance_id}.state.json"))
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T, private: bool) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    let tmp = path.with_extension("json.tmp");
    let raw = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    fs::write(&tmp, raw).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    #[cfg(unix)]
    if private {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    let _ = private;
    fs::rename(&tmp, path).map_err(|e| format!("cannot replace {}: {e}", path.display()))
}

fn read_json<T: for<'de> Deserialize<'de> + Default>(path: &Path) -> T {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

// ── instances ───────────────────────────────────────────────────────────────

pub fn list_instances(project_path: &Path) -> Vec<ConnectorInstance> {
    read_json::<InstancesFile>(&instances_path(project_path)).instances
}

pub fn get_instance(project_path: &Path, id: &str) -> Option<ConnectorInstance> {
    list_instances(project_path).into_iter().find(|i| i.id == id)
}

/// Insert or replace an instance (matched by id).
pub fn upsert_instance(project_path: &Path, instance: ConnectorInstance) -> Result<(), String> {
    let _guard = INSTANCES_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut file = read_json::<InstancesFile>(&instances_path(project_path));
    match file.instances.iter_mut().find(|i| i.id == instance.id) {
        Some(existing) => *existing = instance,
        None => file.instances.push(instance),
    }
    write_json_atomic(&instances_path(project_path), &file, false)
}

/// Update only the `last_sync` summary so a concurrent config edit in the
/// UI is not clobbered by a finishing sync.
pub fn record_sync_summary(
    project_path: &Path,
    id: &str,
    summary: super::SyncSummary,
) -> Result<(), String> {
    let _guard = INSTANCES_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut file = read_json::<InstancesFile>(&instances_path(project_path));
    if let Some(existing) = file.instances.iter_mut().find(|i| i.id == id) {
        existing.last_sync = Some(summary);
        write_json_atomic(&instances_path(project_path), &file, false)?;
    }
    Ok(())
}

pub fn delete_instance(project_path: &Path, id: &str) -> Result<bool, String> {
    let _guard = INSTANCES_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut file = read_json::<InstancesFile>(&instances_path(project_path));
    let before = file.instances.len();
    file.instances.retain(|i| i.id != id);
    let removed = file.instances.len() != before;
    if removed {
        write_json_atomic(&instances_path(project_path), &file, false)?;
        let _ = fs::remove_file(state_path(project_path, id));
    }
    Ok(removed)
}

// ── sync state ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ItemState {
    pub version: String,
    /// Path relative to the project root (forward slashes).
    pub local_path: String,
    #[serde(default)]
    pub remote_path: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncState {
    #[serde(default)]
    pub cursor: Option<String>,
    /// remote id → state
    #[serde(default)]
    pub items: BTreeMap<String, ItemState>,
}

pub fn load_state(project_path: &Path, instance_id: &str) -> SyncState {
    read_json(&state_path(project_path, instance_id))
}

pub fn save_state(project_path: &Path, instance_id: &str, state: &SyncState) -> Result<(), String> {
    write_json_atomic(&state_path(project_path, instance_id), state, false)
}

pub fn reset_state(project_path: &Path, instance_id: &str) {
    let _ = fs::remove_file(state_path(project_path, instance_id));
}

// ── secrets ─────────────────────────────────────────────────────────────────

fn secrets_path(ctx: &AppCtx) -> PathBuf {
    ctx.app_data_dir().join("connectors-secrets.json")
}

pub fn load_secrets(ctx: &AppCtx, instance_id: &str) -> Secrets {
    let all: Map<String, Value> = read_json(&secrets_path(ctx));
    all.get(instance_id)
        .and_then(Value::as_object)
        .cloned()
        .map(Secrets)
        .unwrap_or_default()
}

pub fn save_secrets(ctx: &AppCtx, instance_id: &str, secrets: &Secrets) -> Result<(), String> {
    let _guard = SECRETS_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let path = secrets_path(ctx);
    let mut all: Map<String, Value> = read_json(&path);
    if secrets.0.is_empty() {
        all.remove(instance_id);
    } else {
        all.insert(instance_id.to_string(), Value::Object(secrets.0.clone()));
    }
    write_json_atomic(&path, &all, true)
}

/// Merge new secret values into the stored record (existing keys not
/// present in `patch` are kept — so saving a form without re-entering the
/// client secret does not wipe the tokens).
pub fn merge_secrets(ctx: &AppCtx, instance_id: &str, patch: &Map<String, Value>) -> Result<Secrets, String> {
    let mut current = load_secrets(ctx, instance_id);
    for (key, value) in patch {
        match value {
            Value::Null => current.remove(key),
            Value::String(s) if s.is_empty() => {}
            other => current.set(key, other.clone()),
        }
    }
    save_secrets(ctx, instance_id, &current)?;
    Ok(current)
}

pub fn delete_secrets(ctx: &AppCtx, instance_id: &str) -> Result<(), String> {
    save_secrets(ctx, instance_id, &Secrets::default())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_project() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("llm-wiki-conn-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn instance_roundtrip_and_summary_merge() {
        let project = temp_project();
        let inst = ConnectorInstance {
            id: "one".into(),
            kind: "local-folder".into(),
            name: "Docs".into(),
            enabled: true,
            interval_minutes: 15,
            config: Map::new(),
            max_file_size_mb: 0,
            created_at: 1,
            last_sync: None,
        };
        upsert_instance(&project, inst.clone()).unwrap();
        assert_eq!(list_instances(&project).len(), 1);
        record_sync_summary(
            &project,
            "one",
            super::super::SyncSummary { added: 3, ok: true, ..Default::default() },
        )
        .unwrap();
        let loaded = get_instance(&project, "one").unwrap();
        assert_eq!(loaded.interval_minutes, 15);
        assert_eq!(loaded.last_sync.unwrap().added, 3);
        assert!(delete_instance(&project, "one").unwrap());
        assert!(list_instances(&project).is_empty());
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn secrets_merge_keeps_existing_keys() {
        let data = temp_project();
        let ctx = AppCtx::headless(data.clone(), None);
        let mut first = Map::new();
        first.insert("clientSecret".into(), Value::String("abc".into()));
        merge_secrets(&ctx, "x", &first).unwrap();
        let mut second = Map::new();
        second.insert("refreshToken".into(), Value::String("tok".into()));
        second.insert("clientSecret".into(), Value::String(String::new())); // untouched
        let merged = merge_secrets(&ctx, "x", &second).unwrap();
        assert_eq!(merged.get_str("clientSecret"), Some("abc"));
        assert_eq!(merged.get_str("refreshToken"), Some("tok"));
        let _ = fs::remove_dir_all(data);
    }
}
