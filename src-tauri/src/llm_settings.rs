use serde_json::Value;

use crate::agent::provider::LlmConfig;

pub fn resolve_project_llm_config(
    app_state: &Value,
    project_id: Option<&str>,
) -> Option<LlmConfig> {
    let global_config = app_state.get("llmConfig").cloned();
    let project_settings = project_id.and_then(|id| {
        app_state
            .get("projectLlmSettings")
            .and_then(Value::as_object)
            .and_then(|settings| settings.get(id))
    });

    let selected = match project_settings {
        Some(settings) if has_own(settings, "llmConfig") => settings.get("llmConfig").cloned(),
        Some(settings)
            if has_own(settings, "activePresetId")
                && settings
                    .get("activePresetId")
                    .map(Value::is_null)
                    .unwrap_or(false) =>
        {
            None
        }
        _ => global_config,
    };

    selected.and_then(|value| serde_json::from_value::<LlmConfig>(value).ok())
}

fn has_own(value: &Value, key: &str) -> bool {
    value
        .as_object()
        .map(|object| object.contains_key(key))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn llm(provider: &str, model: &str) -> Value {
        json!({
            "provider": provider,
            "apiKey": "test-key",
            "model": model,
            "customEndpoint": "https://example.invalid/v1/chat/completions",
            "apiMode": "chat_completions",
            "maxContextSize": 12345
        })
    }

    #[test]
    fn falls_back_to_global_when_project_has_no_llm_settings() {
        let state = json!({
            "llmConfig": llm("openai", "global-model"),
            "projectLlmSettings": {
                "project-a": {
                    "providerConfigs": {}
                }
            }
        });

        let config = resolve_project_llm_config(&state, Some("project-a")).unwrap();

        assert_eq!(config.provider, "openai");
        assert_eq!(config.model, "global-model");
    }

    #[test]
    fn uses_project_llm_config_when_present() {
        let state = json!({
            "llmConfig": llm("openai", "global-model"),
            "projectLlmSettings": {
                "project-a": {
                    "llmConfig": llm("custom", "project-model"),
                    "activePresetId": "custom"
                }
            }
        });

        let config = resolve_project_llm_config(&state, Some("project-a")).unwrap();

        assert_eq!(config.provider, "custom");
        assert_eq!(config.model, "project-model");
    }

    #[test]
    fn active_preset_null_without_llm_config_disables_project_llm() {
        let state = json!({
            "llmConfig": llm("openai", "global-model"),
            "projectLlmSettings": {
                "project-a": {
                    "activePresetId": null
                }
            }
        });

        assert!(resolve_project_llm_config(&state, Some("project-a")).is_none());
    }

    #[test]
    fn explicit_null_project_llm_config_disables_project_llm() {
        let state = json!({
            "llmConfig": llm("openai", "global-model"),
            "projectLlmSettings": {
                "project-a": {
                    "llmConfig": null,
                    "activePresetId": null
                }
            }
        });

        assert!(resolve_project_llm_config(&state, Some("project-a")).is_none());
    }

    #[test]
    fn no_project_uses_global_llm_config() {
        let state = json!({
            "llmConfig": llm("openai", "global-model"),
            "projectLlmSettings": {
                "project-a": {
                    "llmConfig": llm("custom", "project-model")
                }
            }
        });

        let config = resolve_project_llm_config(&state, None).unwrap();

        assert_eq!(config.provider, "openai");
        assert_eq!(config.model, "global-model");
    }
}
