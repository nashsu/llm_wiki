use lancedb::connect;
use lancedb::query::{ExecutableQuery, QueryBase};
use arrow_array::{Float32Array, RecordBatch, StringArray, FixedSizeListArray, ArrayRef};
use arrow_schema::{DataType, Field, Schema};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Result from vector search
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct VectorSearchResult {
    pub page_id: String,
    pub score: f32,
}

fn db_path(project_path: &str) -> String {
    format!("{}/.llm-wiki/lancedb", project_path.replace('\\', "/"))
}

const TABLE_NAME: &str = "wiki_vectors";

/// Validate page_id to prevent filter injection
fn validate_page_id(page_id: &str) -> Result<(), String> {
    if page_id.is_empty() || page_id.len() > 256 {
        return Err("Invalid page_id: empty or too long".to_string());
    }
    // Only allow alphanumeric, hyphens, underscores, dots
    if !page_id.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_' || c == '.') {
        return Err(format!("Invalid page_id: contains disallowed characters: {}", page_id));
    }
    Ok(())
}

fn make_schema(dim: i32) -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        Field::new("page_id", DataType::Utf8, false),
        Field::new(
            "vector",
            DataType::FixedSizeList(
                Arc::new(Field::new("item", DataType::Float32, true)),
                dim,
            ),
            false,
        ),
    ]))
}

fn make_batch(schema: Arc<Schema>, page_id: &str, embedding: Vec<f32>, dim: i32) -> Result<RecordBatch, String> {
    let ids: ArrayRef = Arc::new(StringArray::from(vec![page_id]));
    let values = Float32Array::from(embedding);
    let vector: ArrayRef = Arc::new(
        FixedSizeListArray::new(
            Arc::new(Field::new("item", DataType::Float32, true)),
            dim,
            Arc::new(values),
            None,
        )
    );
    RecordBatch::try_new(schema, vec![ids, vector])
        .map_err(|e| format!("Batch error: {e}"))
}

/// Upsert a page embedding into LanceDB
#[tauri::command]
pub async fn vector_upsert(
    project_path: String,
    page_id: String,
    embedding: Vec<f32>,
) -> Result<(), String> {
    validate_page_id(&page_id)?;

    let db = connect(&db_path(&project_path))
        .execute()
        .await
        .map_err(|e| format!("DB connect error: {e}"))?;

    let dim = embedding.len() as i32;
    let schema = make_schema(dim);
    let batch = make_batch(schema.clone(), &page_id, embedding, dim)?;
    let data = vec![batch];

    let tables = db.table_names()
        .execute()
        .await
        .map_err(|e| format!("List tables error: {e}"))?;

    if tables.contains(&TABLE_NAME.to_string()) {
        let table = db.open_table(TABLE_NAME)
            .execute()
            .await
            .map_err(|e| format!("Open table error: {e}"))?;

        // Delete existing entry then add new one
        if let Err(e) = table.delete(&format!("page_id = '{}'", page_id)).await {
            eprintln!("[vectorstore] Warning: delete before upsert failed for '{}': {}", page_id, e);
        }

        table.add(data)
            .execute()
            .await
            .map_err(|e| format!("Add error: {e}"))?;
    } else {
        db.create_table(TABLE_NAME, data)
            .execute()
            .await
            .map_err(|e| format!("Create table error: {e}"))?;
    }

    Ok(())
}

/// Search for similar pages by embedding vector
#[tauri::command]
pub async fn vector_search(
    project_path: String,
    query_embedding: Vec<f32>,
    top_k: usize,
) -> Result<Vec<VectorSearchResult>, String> {
    let db = connect(&db_path(&project_path))
        .execute()
        .await
        .map_err(|e| format!("DB connect error: {e}"))?;

    let tables = db.table_names()
        .execute()
        .await
        .map_err(|e| format!("List tables error: {e}"))?;

    if !tables.contains(&TABLE_NAME.to_string()) {
        return Ok(vec![]);
    }

    let table = db.open_table(TABLE_NAME)
        .execute()
        .await
        .map_err(|e| format!("Open table error: {e}"))?;

    let results_stream = table
        .vector_search(query_embedding)
        .map_err(|e| format!("Search error: {e}"))?
        .limit(top_k)
        .execute()
        .await
        .map_err(|e| format!("Execute search error: {e}"))?;

    let mut search_results = Vec::new();

    use futures::TryStreamExt;
    let batches: Vec<RecordBatch> = results_stream
        .try_collect()
        .await
        .map_err(|e| format!("Collect error: {e}"))?;

    for batch in &batches {
        let ids = batch
            .column_by_name("page_id")
            .and_then(|c| c.as_any().downcast_ref::<StringArray>())
            .ok_or("Missing page_id column")?;

        let distances = batch
            .column_by_name("_distance")
            .and_then(|c| c.as_any().downcast_ref::<Float32Array>())
            .ok_or("Missing _distance column")?;

        for i in 0..batch.num_rows() {
            let page_id = ids.value(i).to_string();
            let distance = distances.value(i);
            let score = 1.0 / (1.0 + distance);
            search_results.push(VectorSearchResult { page_id, score });
        }
    }

    Ok(search_results)
}

/// Delete a page from the vector index
#[tauri::command]
pub async fn vector_delete(
    project_path: String,
    page_id: String,
) -> Result<(), String> {
    validate_page_id(&page_id)?;

    let db = connect(&db_path(&project_path))
        .execute()
        .await
        .map_err(|e| format!("DB connect error: {e}"))?;

    let tables = db.table_names()
        .execute()
        .await
        .map_err(|e| format!("List tables error: {e}"))?;

    if !tables.contains(&TABLE_NAME.to_string()) {
        return Ok(());
    }

    let table = db.open_table(TABLE_NAME)
        .execute()
        .await
        .map_err(|e| format!("Open table error: {e}"))?;

    table.delete(&format!("page_id = '{}'", page_id))
        .await
        .map_err(|e| format!("Delete error: {e}"))?;

    Ok(())
}

/// Get count of indexed vectors
#[tauri::command]
pub async fn vector_count(
    project_path: String,
) -> Result<usize, String> {
    let db = connect(&db_path(&project_path))
        .execute()
        .await
        .map_err(|e| format!("DB connect error: {e}"))?;

    let tables = db.table_names()
        .execute()
        .await
        .map_err(|e| format!("List tables error: {e}"))?;

    if !tables.contains(&TABLE_NAME.to_string()) {
        return Ok(0);
    }

    let table = db.open_table(TABLE_NAME)
        .execute()
        .await
        .map_err(|e| format!("Open table error: {e}"))?;

    let count = table.count_rows(None)
        .await
        .map_err(|e| format!("Count error: {e}"))?;

    Ok(count)
}
