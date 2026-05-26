use serde_json::{json, Value};
use tauri::AppHandle;

use crate::commands;

use super::auth::load_app_state;
use super::common::{err, ok, ApiResponse};
use super::projects::resolve_project;

pub(super) fn handle_rescan(app: &AppHandle, project_id: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(error) => return err(404, error),
    };
    let source_watch_config = load_source_watch_config(app, &project.id);
    match commands::file_sync::rescan_project_files(
        app.clone(),
        project.id.clone(),
        project.path.clone(),
        source_watch_config,
    ) {
        Ok(result) => ok(json!({ "ok": true, "projectId": project.id, "result": result })),
        Err(error) => err(500, error),
    }
}

fn load_source_watch_config(
    app: &AppHandle,
    project_id: &str,
) -> Option<commands::file_sync::SourceWatchConfig> {
    let parsed = load_app_state(app)?;
    let settings = parsed.get("sourceWatchConfig").and_then(Value::as_object);
    if let Some(value) = settings
        .and_then(|state| state.get(project_id).or_else(|| state.get("default")))
        .cloned()
    {
        if let Ok(config) = serde_json::from_value::<commands::file_sync::SourceWatchConfig>(value)
        {
            return Some(config);
        }
    }
    let legacy_enabled = parsed
        .get("projectFileSyncEnabled")
        .and_then(Value::as_object)
        .and_then(|settings| {
            settings
                .get(project_id)
                .or_else(|| settings.get("default"))
                .and_then(Value::as_bool)
        });
    legacy_enabled.and_then(|enabled| {
        serde_json::from_value::<commands::file_sync::SourceWatchConfig>(
            json!({ "enabled": enabled }),
        )
        .ok()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_watch_config_supports_legacy_enabled_shape() {
        let payload = json!({ "enabled": true });
        let parsed =
            serde_json::from_value::<commands::file_sync::SourceWatchConfig>(payload).unwrap();
        let as_value = serde_json::to_value(parsed).unwrap();
        assert_eq!(as_value["enabled"], true);
    }
}
