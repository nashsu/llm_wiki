//! Host-facing commands for the connector system (Tauri IPC + web RPC).

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::{
    descriptors, instance_folder_name, now_ms, oauth, store, sync, ConnectorDescriptor,
    ConnectorInstance, FieldKind,
};
use crate::app_ctx::AppCtx;

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn connector_descriptors() -> Vec<ConnectorDescriptor> {
    descriptors()
}

/// Instance as shown in the UI: config + derived status, never secrets.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorInstanceView {
    #[serde(flatten)]
    pub instance: ConnectorInstance,
    pub folder: String,
    pub running: bool,
    pub auth: Value,
}

fn view(ctx: &AppCtx, project_id: &str, instance: ConnectorInstance) -> ConnectorInstanceView {
    ConnectorInstanceView {
        folder: format!("raw/sources/{}", instance_folder_name(&instance)),
        running: sync::is_running(project_id, &instance.id),
        auth: oauth::status(ctx, &instance.id),
        instance,
    }
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn connector_list(
    ctx: AppCtx,
    project_id: String,
    project_path: String,
) -> Result<Vec<ConnectorInstanceView>, String> {
    Ok(store::list_instances(Path::new(&project_path))
        .into_iter()
        .map(|i| view(&ctx, &project_id, i))
        .collect())
}

/// What the settings form submits. `secrets` carries values for
/// `FieldKind::Secret` fields the user (re-)entered; blanks keep what is
/// stored.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorSaveInput {
    #[serde(default)]
    pub id: Option<String>,
    pub kind: String,
    pub name: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub interval_minutes: u32,
    #[serde(default)]
    pub config: Map<String, Value>,
    #[serde(default)]
    pub max_file_size_mb: u64,
    #[serde(default)]
    pub secrets: Map<String, Value>,
}

fn default_enabled() -> bool {
    true
}

fn descriptor_for(kind: &str) -> Result<ConnectorDescriptor, String> {
    descriptors()
        .into_iter()
        .find(|d| d.kind == kind)
        .ok_or_else(|| format!("Unknown connector kind: {kind}"))
}

fn is_blank(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => true,
        Some(Value::String(s)) => s.trim().is_empty(),
        _ => false,
    }
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn connector_save(
    ctx: AppCtx,
    project_id: String,
    project_path: String,
    input: ConnectorSaveInput,
) -> Result<ConnectorInstanceView, String> {
    let descriptor = descriptor_for(&input.kind)?;
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err("Give the connector a name".into());
    }
    let project = Path::new(&project_path);
    let existing = input
        .id
        .as_deref()
        .filter(|id| !id.is_empty())
        .and_then(|id| store::get_instance(project, id));
    let id = existing
        .as_ref()
        .map(|i| i.id.clone())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    // Split submitted values: secret fields go to the secrets file, the
    // rest stays in the project config. Validate required fields.
    let mut config = Map::new();
    let mut secret_patch = Map::new();
    let stored_secrets = store::load_secrets(&ctx, &id);
    for field in &descriptor.fields {
        let submitted = input
            .config
            .get(&field.key)
            .or_else(|| input.secrets.get(&field.key));
        if field.kind == FieldKind::Secret {
            if let Some(value) = submitted.cloned().filter(|v| !is_blank(Some(v))) {
                secret_patch.insert(field.key.clone(), value);
            } else if field.required && stored_secrets.get_str(&field.key).is_none() {
                return Err(format!("{} is required", field.label));
            }
            continue;
        }
        let value = submitted.cloned().or_else(|| field.default.clone());
        if field.required && is_blank(value.as_ref()) {
            return Err(format!("{} is required", field.label));
        }
        if let Some(v) = value {
            config.insert(field.key.clone(), v);
        }
    }

    let instance = ConnectorInstance {
        id: id.clone(),
        kind: input.kind.clone(),
        name,
        enabled: input.enabled,
        interval_minutes: input.interval_minutes,
        config,
        max_file_size_mb: input.max_file_size_mb,
        created_at: existing.as_ref().map(|i| i.created_at).unwrap_or_else(now_ms),
        last_sync: existing.as_ref().and_then(|i| i.last_sync.clone()),
    };
    // Renaming moves the mirror folder: force a clean resync.
    if let Some(prev) = &existing {
        if instance_folder_name(prev) != instance_folder_name(&instance) {
            sync::purge_instance_files(project, prev);
            store::reset_state(project, &id);
        }
    }
    store::upsert_instance(project, instance.clone())?;
    if !secret_patch.is_empty() {
        store::merge_secrets(&ctx, &id, &secret_patch)?;
    }
    if let Some(client_id) = instance.config.get("clientId").and_then(Value::as_str) {
        oauth::remember_client_id(&ctx, &id, client_id)?;
    }
    Ok(view(&ctx, &project_id, instance))
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn connector_delete(
    ctx: AppCtx,
    project_path: String,
    id: String,
    purge_files: Option<bool>,
) -> Result<bool, String> {
    let project = Path::new(&project_path);
    if let Some(instance) = store::get_instance(project, &id) {
        if purge_files.unwrap_or(false) {
            sync::purge_instance_files(project, &instance);
        }
    }
    let removed = store::delete_instance(project, &id)?;
    let _ = store::delete_secrets(&ctx, &id);
    Ok(removed)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn connector_test(ctx: AppCtx, project_path: String, id: String) -> Result<String, String> {
    let instance = store::get_instance(Path::new(&project_path), &id)
        .ok_or_else(|| format!("Unknown connector instance: {id}"))?;
    let secrets = store::load_secrets(&ctx, &id);
    let connector = super::build(&ctx, &instance, &secrets)?;
    connector.test().await
}

/// Kick off a sync in the background. Progress and the final report arrive
/// as `connectors://sync` events; `connector_list` shows the summary.
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn connector_sync(
    ctx: AppCtx,
    project_id: String,
    project_path: String,
    id: String,
) -> Result<Value, String> {
    if sync::is_running(&project_id, &id) {
        return Err("A sync for this connector is already running".into());
    }
    store::get_instance(Path::new(&project_path), &id)
        .ok_or_else(|| format!("Unknown connector instance: {id}"))?;
    crate::rt::spawn(async move {
        if let Err(err) = sync::run_sync(&ctx, &project_id, Path::new(&project_path), &id).await {
            eprintln!("[connectors] sync {id} failed: {err}");
            let _ = ctx.emit(
                sync::EVENT_SYNC,
                json!({ "projectId": project_id, "instanceId": id, "phase": "failed", "error": err }),
            );
        }
    });
    Ok(json!({ "started": true }))
}

/// Forget the sync state so the next run re-lists everything (keeps files).
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn connector_reset(project_path: String, id: String) -> Result<(), String> {
    store::reset_state(Path::new(&project_path), &id);
    Ok(())
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn connector_oauth_start(
    ctx: AppCtx,
    project_path: String,
    id: String,
    redirect_uri: String,
) -> Result<String, String> {
    oauth::start(&ctx, &project_path, &id, &redirect_uri)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn connector_oauth_disconnect(ctx: AppCtx, id: String) -> Result<(), String> {
    oauth::disconnect(&ctx, &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_validates_required_and_splits_secrets() {
        let base = std::env::temp_dir().join(format!("llm-wiki-cmd-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let ctx = AppCtx::headless(base.join("data"), None);
        let project = base.to_string_lossy().into_owned();

        let missing = connector_save(
            ctx.clone(),
            "p".into(),
            project.clone(),
            ConnectorSaveInput {
                id: None,
                kind: "google-drive".into(),
                name: "Drive".into(),
                enabled: true,
                interval_minutes: 30,
                config: Map::new(),
                max_file_size_mb: 0,
                secrets: Map::new(),
            },
        )
        .unwrap_err();
        assert!(missing.contains("client ID"), "{missing}");

        let mut config = Map::new();
        config.insert("clientId".into(), Value::String("cid".into()));
        let mut secrets = Map::new();
        secrets.insert("clientSecret".into(), Value::String("shh".into()));
        let saved = connector_save(
            ctx.clone(),
            "p".into(),
            project.clone(),
            ConnectorSaveInput {
                id: None,
                kind: "google-drive".into(),
                name: "Drive".into(),
                enabled: true,
                interval_minutes: 30,
                config,
                max_file_size_mb: 0,
                secrets,
            },
        )
        .unwrap();
        assert!(!saved.instance.config.contains_key("clientSecret"));
        assert_eq!(saved.auth["hasClientSecret"], true);
        assert_eq!(saved.auth["connected"], false);
        assert_eq!(saved.folder, "raw/sources/@Drive");
        let stored = store::load_secrets(&ctx, &saved.instance.id);
        assert_eq!(stored.get_str("clientSecret"), Some("shh"));
        assert_eq!(stored.get_str("clientId"), Some("cid"));
        let _ = std::fs::remove_dir_all(base);
    }
}
