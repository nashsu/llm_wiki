use serde::Deserialize;
use serde_json::json;
use tauri::AppHandle;

use crate::commands;

use super::auth::load_app_state;
use super::common::{err, ok, ApiResponse};
use super::projects::resolve_project;
use super::MAX_SEARCH_RESULTS;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchRequest {
    query: String,
    top_k: Option<usize>,
    include_content: Option<bool>,
    query_embedding: Option<Vec<f32>>,
}

pub(super) fn handle_search(app: &AppHandle, project_id: &str, body: &str) -> ApiResponse {
    let project = match resolve_project(app, project_id) {
        Ok(project) => project,
        Err(error) => return err(404, error),
    };
    let req: SearchRequest = match serde_json::from_str(body) {
        Ok(req) => req,
        Err(error) => return err(400, format!("Invalid JSON: {error}")),
    };
    if req.query.trim().is_empty() {
        return err(400, "query is required");
    }
    let top_k = req.top_k.unwrap_or(10).clamp(1, MAX_SEARCH_RESULTS);
    let query = req.query;
    let query_embedding =
        match tauri::async_runtime::block_on(commands::search::resolve_query_embedding(
            &query,
            req.query_embedding,
            load_embedding_config(app),
        )) {
            Ok(embedding) => embedding,
            Err(error) => return err(400, error),
        };
    match tauri::async_runtime::block_on(commands::search::search_project_inner(
        project.path.clone(),
        query,
        top_k,
        req.include_content.unwrap_or(false),
        query_embedding,
    )) {
        Ok(search) => ok(json!({
            "ok": true,
            "projectId": project.id,
            "mode": search.mode,
            "note": "Search uses the shared backend retrieval service. When embeddingConfig is enabled, the API automatically includes LanceDB vector results; clients may also pass queryEmbedding explicitly.",
            "tokenHits": search.token_hits,
            "vectorHits": search.vector_hits,
            "results": search.results,
        })),
        Err(error) => err(500, error),
    }
}

fn load_embedding_config(app: &AppHandle) -> Option<commands::search::SearchEmbeddingConfig> {
    let parsed = load_app_state(app)?;
    let value = parsed.get("embeddingConfig")?.clone();
    serde_json::from_value::<commands::search::SearchEmbeddingConfig>(value).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedding_config_parses_from_app_state_shape() {
        let payload = json!({
            "embeddingConfig": {
                "enabled": true,
                "endpoint": "http://localhost:1234/v1/embeddings",
                "apiKey": "k",
                "model": "m"
            }
        });
        let value = payload.get("embeddingConfig").unwrap().clone();
        let parsed =
            serde_json::from_value::<commands::search::SearchEmbeddingConfig>(value).unwrap();
        assert!(parsed.enabled);
        assert_eq!(parsed.model, "m");
    }
}
