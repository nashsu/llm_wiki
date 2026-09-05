//! JSON-RPC bridge: maps the command names the frontend passes to
//! `invoke(name, args)` onto the same Rust functions the Tauri IPC layer
//! calls. Argument objects use the camelCase keys the frontend already sends
//! (Tauri performs the same camelCase → snake_case mapping internally).
//!
//! Keep this table in sync with `generate_handler!` in `lib.rs`; the
//! `rpc_covers_every_tauri_command` test checks that every command registered
//! for the desktop app is also reachable here.

use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::app_ctx::AppCtx;
use crate::{agent, app_commands, commands, proxy};

use super::store;

/// Names of every command reachable through [`dispatch`].
pub const COMMANDS: &[&str] = &[
    "read_file",
    "write_file",
    "write_file_base64",
    "write_file_atomic",
    "apply_text_selection_edit",
    "create_missing_wiki_page",
    "list_file_history",
    "restore_file_history",
    "get_file_history_stats",
    "get_file_history_settings",
    "set_file_history_settings",
    "clear_file_history",
    "list_directory",
    "copy_file",
    "copy_directory",
    "preprocess_file",
    "delete_file",
    "find_related_wiki_pages",
    "create_directory",
    "file_exists",
    "get_file_modified_time",
    "get_file_size",
    "get_file_md5",
    "read_file_as_base64",
    "create_project",
    "open_project",
    "open_project_folder",
    "open_path_in_project",
    "export_project_archive",
    "import_project_archive",
    "rebuild_wiki_index",
    "search_project",
    "embedding_fetch",
    "embedding_fetch_batch",
    "get_page_links",
    "web_search",
    "anytxt_search",
    "clip_server_status",
    "api_server_status",
    "api_server_reload_config",
    "agent_start_turn",
    "agent_start_turn_stream",
    "agent_cancel_turn",
    "agent_get_session",
    "agent_list_sessions",
    "agent_list_skills",
    "mcp_server_entry_path",
    "vector_upsert",
    "vector_search",
    "vector_delete",
    "vector_count",
    "vector_upsert_chunks",
    "vector_search_chunks",
    "vector_delete_page",
    "vector_count_chunks",
    "vector_clear_chunks",
    "vector_optimize_chunks",
    "vector_legacy_row_count",
    "vector_drop_legacy",
    "claude_cli_detect",
    "claude_cli_spawn",
    "claude_cli_kill",
    "codex_cli_detect",
    "codex_cli_spawn",
    "codex_cli_kill",
    "extract_pdf_images_cmd",
    "extract_office_images_cmd",
    "extract_and_save_pdf_images_cmd",
    "extract_and_save_office_images_cmd",
    "start_project_file_watcher",
    "stop_project_file_watcher",
    "rescan_project_files",
    "get_file_change_queue",
    "retry_file_change_task",
    "ignore_file_change_task",
    "set_proxy_env",
    "set_close_behavior",
    "connector_descriptors",
    "connector_list",
    "connector_save",
    "connector_delete",
    "connector_test",
    "connector_sync",
    "connector_reset",
    "connector_oauth_start",
    "connector_oauth_disconnect",
    // Web-only commands (replacements for Tauri plugins).
    "web_store_get",
    "web_store_set",
    "web_store_delete",
    "web_store_clear",
    "web_store_entries",
    "web_list_dirs",
    "web_home_dir",
    "web_runtime_info",
];

fn parse<T: DeserializeOwned>(args: &Value) -> Result<T, String> {
    serde_json::from_value(args.clone()).map_err(|e| format!("Invalid arguments: {e}"))
}

fn out<T: serde::Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| format!("Failed to serialize result: {e}"))
}

/// Run a synchronous command on the blocking pool so slow filesystem work
/// never stalls the HTTP workers.
async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    crate::rt::spawn_blocking(f)
        .await
        .map_err(|e| format!("Command task failed: {e}"))
}

macro_rules! args {
    ($name:ident { $($field:ident : $ty:ty),* $(,)? }) => {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct $name { $( $field: $ty ),* }
    };
}

/// Dispatch one command. Unknown names yield `Err(UNKNOWN_COMMAND)`.
pub async fn dispatch(ctx: &AppCtx, name: &str, args: Value) -> Result<Value, String> {
    let ctx = ctx.clone();
    match name {
        // ── fs ──────────────────────────────────────────────────────────
        "read_file" => {
            args!(A { path: String, extract_images: Option<bool> });
            let a: A = parse(&args)?;
            out(commands::fs::read_file(a.path, a.extract_images).await?)
        }
        "write_file" => {
            args!(A { path: String, contents: String });
            let a: A = parse(&args)?;
            out(commands::fs::write_file(a.path, a.contents).await?)
        }
        "write_file_base64" => {
            args!(A { path: String, base64: String });
            let a: A = parse(&args)?;
            out(commands::fs::write_file_base64(a.path, a.base64).await?)
        }
        "write_file_atomic" => {
            args!(A { path: String, contents: String });
            let a: A = parse(&args)?;
            out(commands::fs::write_file_atomic(a.path, a.contents).await?)
        }
        "apply_text_selection_edit" => {
            args!(A {
                project_path: String,
                file_path: String,
                prefix: String,
                selected_text: String,
                suffix: String,
                replacement: String,
            });
            let a: A = parse(&args)?;
            out(
                commands::fs::apply_text_selection_edit(
                    a.project_path,
                    a.file_path,
                    a.prefix,
                    a.selected_text,
                    a.suffix,
                    a.replacement,
                )
                .await?,
            )
        }
        "create_missing_wiki_page" => {
            args!(A { project_path: String, title: String, content: Option<String> });
            let a: A = parse(&args)?;
            out(commands::fs::create_missing_wiki_page(a.project_path, a.title, a.content).await?)
        }
        "list_directory" => {
            args!(A { path: String, include_hidden: Option<bool>, max_depth: Option<usize> });
            let a: A = parse(&args)?;
            out(commands::fs::list_directory(a.path, a.include_hidden, a.max_depth).await?)
        }
        "copy_file" => {
            args!(A { source: String, destination: String });
            let a: A = parse(&args)?;
            out(commands::fs::copy_file(a.source, a.destination).await?)
        }
        "copy_directory" => {
            args!(A { source: String, destination: String });
            let a: A = parse(&args)?;
            out(commands::fs::copy_directory(a.source, a.destination).await?)
        }
        "preprocess_file" => {
            args!(A { path: String });
            let a: A = parse(&args)?;
            out(commands::fs::preprocess_file(a.path).await?)
        }
        "delete_file" => {
            args!(A { path: String });
            let a: A = parse(&args)?;
            out(commands::fs::delete_file(a.path).await?)
        }
        "find_related_wiki_pages" => {
            args!(A { project_path: String, source_name: String });
            let a: A = parse(&args)?;
            out(commands::fs::find_related_wiki_pages(a.project_path, a.source_name).await?)
        }
        "create_directory" => {
            args!(A { path: String });
            let a: A = parse(&args)?;
            out(commands::fs::create_directory(a.path).await?)
        }
        "file_exists" => {
            args!(A { path: String });
            let a: A = parse(&args)?;
            out(commands::fs::file_exists(a.path).await?)
        }
        "get_file_modified_time" => {
            args!(A { path: String });
            let a: A = parse(&args)?;
            out(commands::fs::get_file_modified_time(a.path).await?)
        }
        "get_file_size" => {
            args!(A { path: String });
            let a: A = parse(&args)?;
            out(commands::fs::get_file_size(a.path).await?)
        }
        "get_file_md5" => {
            args!(A { path: String });
            let a: A = parse(&args)?;
            out(commands::fs::get_file_md5(a.path).await?)
        }
        "read_file_as_base64" => {
            args!(A { path: String });
            let a: A = parse(&args)?;
            out(commands::fs::read_file_as_base64(a.path).await?)
        }

        // ── file history ────────────────────────────────────────────────
        "list_file_history" => {
            args!(A { project_path: String, file_path: String });
            let a: A = parse(&args)?;
            out(commands::file_history::list_file_history(a.project_path, a.file_path).await?)
        }
        "restore_file_history" => {
            args!(A { project_path: String, file_path: String, entry_id: String });
            let a: A = parse(&args)?;
            out(
                commands::file_history::restore_file_history(a.project_path, a.file_path, a.entry_id)
                    .await?,
            )
        }
        "get_file_history_stats" => {
            args!(A { project_path: String });
            let a: A = parse(&args)?;
            out(commands::file_history::get_file_history_stats(a.project_path).await?)
        }
        "get_file_history_settings" => {
            args!(A { project_path: String });
            let a: A = parse(&args)?;
            out(commands::file_history::get_file_history_settings(a.project_path).await?)
        }
        "set_file_history_settings" => {
            args!(A { project_path: String, settings: commands::file_history::FileHistorySettings });
            let a: A = parse(&args)?;
            out(commands::file_history::set_file_history_settings(a.project_path, a.settings).await?)
        }
        "clear_file_history" => {
            args!(A { project_path: String });
            let a: A = parse(&args)?;
            out(commands::file_history::clear_file_history(a.project_path).await?)
        }

        // ── project ─────────────────────────────────────────────────────
        "create_project" => {
            args!(A { name: String, path: String });
            let a: A = parse(&args)?;
            out(blocking(move || commands::project::create_project(a.name, a.path)).await??)
        }
        "open_project" => {
            args!(A { path: String });
            let a: A = parse(&args)?;
            out(blocking(move || commands::project::open_project(a.path)).await??)
        }
        "open_project_folder" => {
            args!(A { path: String });
            let a: A = parse(&args)?;
            out(blocking(move || commands::project::open_project_folder(ctx, a.path)).await??)
        }
        "open_path_in_project" => {
            args!(A { project_path: String, target_path: String });
            let a: A = parse(&args)?;
            out(
                blocking(move || {
                    commands::project::open_path_in_project(ctx, a.project_path, a.target_path)
                })
                .await??,
            )
        }
        "export_project_archive" => {
            args!(A { project_path: String, destination: String });
            let a: A = parse(&args)?;
            out(
                commands::project_maintenance::export_project_archive(a.project_path, a.destination)
                    .await?,
            )
        }
        "import_project_archive" => {
            args!(A { archive_path: String, destination: String });
            let a: A = parse(&args)?;
            out(
                commands::project_maintenance::import_project_archive(a.archive_path, a.destination)
                    .await?,
            )
        }
        "rebuild_wiki_index" => {
            args!(A { project_path: String });
            let a: A = parse(&args)?;
            out(commands::project_maintenance::rebuild_wiki_index(a.project_path).await?)
        }

        // ── search / embeddings ─────────────────────────────────────────
        "search_project" => {
            args!(A {
                project_path: String,
                query: String,
                top_k: Option<usize>,
                include_content: Option<bool>,
                query_embedding: Option<Vec<f32>>,
                embedding_config: Option<commands::search::SearchEmbeddingConfig>,
            });
            let a: A = parse(&args)?;
            out(
                commands::search::search_project(
                    a.project_path,
                    a.query,
                    a.top_k,
                    a.include_content,
                    a.query_embedding,
                    a.embedding_config,
                )
                .await?,
            )
        }
        "embedding_fetch" => {
            args!(A { text: String, cfg: commands::search::SearchEmbeddingConfig, max_retries: Option<usize> });
            let a: A = parse(&args)?;
            out(commands::search::embedding_fetch(a.text, a.cfg, a.max_retries).await?)
        }
        "embedding_fetch_batch" => {
            args!(A { texts: Vec<String>, cfg: commands::search::SearchEmbeddingConfig });
            let a: A = parse(&args)?;
            out(commands::search::embedding_fetch_batch(a.texts, a.cfg).await?)
        }
        "get_page_links" => {
            args!(A { project_path: String, file_path: String });
            let a: A = parse(&args)?;
            out(commands::search::get_page_links(a.project_path, a.file_path).await?)
        }
        "web_search" => {
            args!(A { query: String, config: agent::tools::WebSearchConfig, max_results: Option<usize> });
            let a: A = parse(&args)?;
            out(commands::external_search::web_search(a.query, a.config, a.max_results).await?)
        }
        "anytxt_search" => {
            args!(A { query: String, config: agent::tools::AnyTxtConfig, max_results: Option<usize> });
            let a: A = parse(&args)?;
            out(commands::external_search::anytxt_search(a.query, a.config, a.max_results).await?)
        }

        // ── app / agent ─────────────────────────────────────────────────
        "clip_server_status" => out(app_commands::clip_server_status()),
        "api_server_status" => out(app_commands::api_server_status()),
        "api_server_reload_config" => out(app_commands::api_server_reload_config()),
        "agent_start_turn" => {
            args!(A {
                project_id: String,
                request: agent::AgentChatRequest,
                llm_config: Option<agent::provider::LlmConfig>,
            });
            let a: A = parse(&args)?;
            out(app_commands::agent_start_turn(ctx, a.project_id, a.request, a.llm_config).await?)
        }
        "agent_start_turn_stream" => {
            args!(A {
                project_id: String,
                request: agent::AgentChatRequest,
                llm_config: Option<agent::provider::LlmConfig>,
            });
            let a: A = parse(&args)?;
            out(
                app_commands::agent_start_turn_stream(ctx, a.project_id, a.request, a.llm_config)
                    .await?,
            )
        }
        "agent_cancel_turn" => {
            args!(A { project_id: String, session_id: String, run_id: Option<String> });
            let a: A = parse(&args)?;
            out(app_commands::agent_cancel_turn(ctx, a.project_id, a.session_id, a.run_id)?)
        }
        "agent_get_session" => {
            args!(A { project_id: String, session_id: String, limit: Option<usize> });
            let a: A = parse(&args)?;
            out(app_commands::agent_get_session(ctx, a.project_id, a.session_id, a.limit)?)
        }
        "agent_list_sessions" => {
            args!(A { project_id: String });
            let a: A = parse(&args)?;
            out(app_commands::agent_list_sessions(ctx, a.project_id)?)
        }
        "agent_list_skills" => {
            args!(A { project_path: String });
            let a: A = parse(&args)?;
            out(blocking(move || agent::skills::agent_list_skills(a.project_path)).await?)
        }
        "mcp_server_entry_path" => out(app_commands::mcp_server_entry_path(ctx)?),

        // ── vector store ────────────────────────────────────────────────
        "vector_upsert" => {
            args!(A { project_path: String, page_id: String, embedding: Vec<f32> });
            let a: A = parse(&args)?;
            out(commands::vectorstore::vector_upsert(a.project_path, a.page_id, a.embedding).await?)
        }
        "vector_search" => {
            args!(A { project_path: String, query_embedding: Vec<f32>, top_k: usize });
            let a: A = parse(&args)?;
            out(commands::vectorstore::vector_search(a.project_path, a.query_embedding, a.top_k).await?)
        }
        "vector_delete" => {
            args!(A { project_path: String, page_id: String });
            let a: A = parse(&args)?;
            out(commands::vectorstore::vector_delete(a.project_path, a.page_id).await?)
        }
        "vector_count" => {
            args!(A { project_path: String });
            let a: A = parse(&args)?;
            out(commands::vectorstore::vector_count(a.project_path).await?)
        }
        "vector_upsert_chunks" => {
            args!(A { project_path: String, page_id: String, chunks: Vec<commands::vectorstore::ChunkUpsertInput> });
            let a: A = parse(&args)?;
            out(commands::vectorstore::vector_upsert_chunks(a.project_path, a.page_id, a.chunks).await?)
        }
        "vector_search_chunks" => {
            args!(A { project_path: String, query_embedding: Vec<f32>, top_k: usize });
            let a: A = parse(&args)?;
            out(
                commands::vectorstore::vector_search_chunks(a.project_path, a.query_embedding, a.top_k)
                    .await?,
            )
        }
        "vector_delete_page" => {
            args!(A { project_path: String, page_id: String });
            let a: A = parse(&args)?;
            out(commands::vectorstore::vector_delete_page(a.project_path, a.page_id).await?)
        }
        "vector_count_chunks" => {
            args!(A { project_path: String });
            let a: A = parse(&args)?;
            out(commands::vectorstore::vector_count_chunks(a.project_path).await?)
        }
        "vector_clear_chunks" => {
            args!(A { project_path: String });
            let a: A = parse(&args)?;
            out(commands::vectorstore::vector_clear_chunks(a.project_path).await?)
        }
        "vector_optimize_chunks" => {
            args!(A { project_path: String });
            let a: A = parse(&args)?;
            out(commands::vectorstore::vector_optimize_chunks(a.project_path).await?)
        }
        "vector_legacy_row_count" => {
            args!(A { project_path: String });
            let a: A = parse(&args)?;
            out(commands::vectorstore::vector_legacy_row_count(a.project_path).await?)
        }
        "vector_drop_legacy" => {
            args!(A { project_path: String });
            let a: A = parse(&args)?;
            out(commands::vectorstore::vector_drop_legacy(a.project_path).await?)
        }

        // ── CLI transports ──────────────────────────────────────────────
        "claude_cli_detect" => out(commands::claude_cli::claude_cli_detect().await?),
        "claude_cli_spawn" => {
            args!(A {
                stream_id: String,
                model: String,
                messages: Vec<commands::claude_cli::ClaudeMessage>,
                isolate_local_config: bool,
                working_directory: Option<String>,
            });
            let a: A = parse(&args)?;
            out(
                commands::claude_cli::claude_cli_spawn(
                    ctx,
                    a.stream_id,
                    a.model,
                    a.messages,
                    a.isolate_local_config,
                    a.working_directory,
                )
                .await?,
            )
        }
        "claude_cli_kill" => {
            args!(A { stream_id: String });
            let a: A = parse(&args)?;
            out(commands::claude_cli::claude_cli_kill(ctx, a.stream_id).await?)
        }
        "codex_cli_detect" => out(commands::codex_cli::codex_cli_detect().await?),
        "codex_cli_spawn" => {
            args!(A {
                stream_id: String,
                model: String,
                prompt: String,
                isolate_local_config: bool,
                timeout_minutes: Option<u64>,
                working_directory: Option<String>,
            });
            let a: A = parse(&args)?;
            out(
                commands::codex_cli::codex_cli_spawn(
                    ctx,
                    a.stream_id,
                    a.model,
                    a.prompt,
                    a.isolate_local_config,
                    a.timeout_minutes,
                    a.working_directory,
                )
                .await?,
            )
        }
        "codex_cli_kill" => {
            args!(A { stream_id: String });
            let a: A = parse(&args)?;
            out(commands::codex_cli::codex_cli_kill(ctx, a.stream_id).await?)
        }

        // ── image extraction ────────────────────────────────────────────
        "extract_pdf_images_cmd" => {
            args!(A { path: String });
            let a: A = parse(&args)?;
            out(commands::extract_images::extract_pdf_images_cmd(a.path).await?)
        }
        "extract_office_images_cmd" => {
            args!(A { path: String });
            let a: A = parse(&args)?;
            out(commands::extract_images::extract_office_images_cmd(a.path).await?)
        }
        "extract_and_save_pdf_images_cmd" => {
            args!(A { source_path: String, dest_dir: String, rel_to: String });
            let a: A = parse(&args)?;
            out(
                commands::extract_images::extract_and_save_pdf_images_cmd(
                    a.source_path,
                    a.dest_dir,
                    a.rel_to,
                )
                .await?,
            )
        }
        "extract_and_save_office_images_cmd" => {
            args!(A { source_path: String, dest_dir: String, rel_to: String });
            let a: A = parse(&args)?;
            out(
                commands::extract_images::extract_and_save_office_images_cmd(
                    a.source_path,
                    a.dest_dir,
                    a.rel_to,
                )
                .await?,
            )
        }

        // ── source folder watcher ───────────────────────────────────────
        "start_project_file_watcher" => {
            args!(A {
                project_id: String,
                project_path: String,
                source_watch_config: Option<commands::file_sync::SourceWatchConfig>,
            });
            let a: A = parse(&args)?;
            out(
                blocking(move || {
                    commands::file_sync::start_project_file_watcher(
                        ctx,
                        a.project_id,
                        a.project_path,
                        a.source_watch_config,
                    )
                })
                .await??,
            )
        }
        "stop_project_file_watcher" => {
            out(blocking(move || commands::file_sync::stop_project_file_watcher(ctx)).await??)
        }
        "rescan_project_files" => {
            args!(A {
                project_id: String,
                project_path: String,
                source_watch_config: Option<commands::file_sync::SourceWatchConfig>,
            });
            let a: A = parse(&args)?;
            out(
                blocking(move || {
                    commands::file_sync::rescan_project_files(
                        ctx,
                        a.project_id,
                        a.project_path,
                        a.source_watch_config,
                    )
                })
                .await??,
            )
        }
        "get_file_change_queue" => {
            args!(A { project_path: String });
            let a: A = parse(&args)?;
            out(blocking(move || commands::file_sync::get_file_change_queue(a.project_path)).await??)
        }
        "retry_file_change_task" => {
            args!(A { project_id: String, project_path: String, task_id: String });
            let a: A = parse(&args)?;
            out(
                blocking(move || {
                    commands::file_sync::retry_file_change_task(
                        ctx,
                        a.project_id,
                        a.project_path,
                        a.task_id,
                    )
                })
                .await??,
            )
        }
        "ignore_file_change_task" => {
            args!(A { project_id: String, project_path: String, task_id: String });
            let a: A = parse(&args)?;
            out(
                blocking(move || {
                    commands::file_sync::ignore_file_change_task(
                        ctx,
                        a.project_id,
                        a.project_path,
                        a.task_id,
                    )
                })
                .await??,
            )
        }

        // ── misc ────────────────────────────────────────────────────────
        "set_proxy_env" => {
            args!(A { config: proxy::ProxyConfig });
            let a: A = parse(&args)?;
            out(app_commands::set_proxy_env(a.config))
        }
        "set_close_behavior" => {
            // Window close behaviour only exists on the desktop; accept and
            // echo the value so the settings UI stays consistent.
            args!(A { value: String });
            let a: A = parse(&args)?;
            out(a.value)
        }

        // ── connectors ──────────────────────────────────────────────────
        "connector_descriptors" => out(crate::connectors::commands::connector_descriptors()),
        "connector_list" => {
            args!(A { project_id: String, project_path: String });
            let a: A = parse(&args)?;
            out(blocking(move || {
                crate::connectors::commands::connector_list(ctx, a.project_id, a.project_path)
            })
            .await??)
        }
        "connector_save" => {
            args!(A {
                project_id: String,
                project_path: String,
                input: crate::connectors::commands::ConnectorSaveInput,
            });
            let a: A = parse(&args)?;
            out(blocking(move || {
                crate::connectors::commands::connector_save(ctx, a.project_id, a.project_path, a.input)
            })
            .await??)
        }
        "connector_delete" => {
            args!(A { project_path: String, id: String, purge_files: Option<bool> });
            let a: A = parse(&args)?;
            out(blocking(move || {
                crate::connectors::commands::connector_delete(ctx, a.project_path, a.id, a.purge_files)
            })
            .await??)
        }
        "connector_test" => {
            args!(A { project_path: String, id: String });
            let a: A = parse(&args)?;
            out(crate::connectors::commands::connector_test(ctx, a.project_path, a.id).await?)
        }
        "connector_sync" => {
            args!(A { project_id: String, project_path: String, id: String });
            let a: A = parse(&args)?;
            out(crate::connectors::commands::connector_sync(ctx, a.project_id, a.project_path, a.id)?)
        }
        "connector_reset" => {
            args!(A { project_path: String, id: String });
            let a: A = parse(&args)?;
            out(crate::connectors::commands::connector_reset(a.project_path, a.id)?)
        }
        "connector_oauth_start" => {
            args!(A { project_path: String, id: String, redirect_uri: String });
            let a: A = parse(&args)?;
            out(crate::connectors::commands::connector_oauth_start(
                ctx,
                a.project_path,
                a.id,
                a.redirect_uri,
            )?)
        }
        "connector_oauth_disconnect" => {
            args!(A { id: String });
            let a: A = parse(&args)?;
            out(crate::connectors::commands::connector_oauth_disconnect(ctx, a.id)?)
        }

        // ── web-only replacements for Tauri plugins ─────────────────────
        "web_store_get" => {
            args!(A { key: String });
            let a: A = parse(&args)?;
            let path = ctx.app_state_path();
            out(blocking(move || store::get(&path, &a.key)).await?)
        }
        "web_store_set" => {
            args!(A { key: String, value: Value });
            let a: A = parse(&args)?;
            let path = ctx.app_state_path();
            let result = blocking(move || store::set(&path, &a.key, a.value)).await??;
            // The API server caches app-state.json; make settings edits
            // visible to it immediately, like the desktop app does after
            // saving through the plugin store.
            crate::api_server::invalidate_config_cache();
            out(result)
        }
        "web_store_delete" => {
            args!(A { key: String });
            let a: A = parse(&args)?;
            let path = ctx.app_state_path();
            let result = blocking(move || store::delete(&path, &a.key)).await??;
            crate::api_server::invalidate_config_cache();
            out(result)
        }
        "web_store_clear" => {
            let path = ctx.app_state_path();
            let result = blocking(move || store::clear(&path)).await??;
            crate::api_server::invalidate_config_cache();
            out(result)
        }
        "web_store_entries" => {
            let path = ctx.app_state_path();
            out(blocking(move || store::entries(&path)).await?)
        }
        "web_list_dirs" => {
            args!(A { path: Option<String> });
            let a: A = parse(&args)?;
            out(blocking(move || list_dirs(a.path)).await??)
        }
        "web_home_dir" => out(home_dir()),
        "web_runtime_info" => out(json!({
            "mode": if ctx.is_desktop() { "desktop" } else { "server" },
            "version": env!("CARGO_PKG_VERSION"),
            "dataDir": ctx.app_data_dir(),
            "homeDir": home_dir(),
            "os": std::env::consts::OS,
            "pathSeparator": std::path::MAIN_SEPARATOR.to_string(),
        })),
        _ => Err(UNKNOWN_COMMAND.to_string()),
    }
}

pub const UNKNOWN_COMMAND: &str = "unknown command";

fn home_dir() -> String {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| "/".to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DirListing {
    path: String,
    parent: Option<String>,
    entries: Vec<DirEntry>,
}

#[derive(serde::Serialize)]
struct DirEntry {
    name: String,
    path: String,
}

/// Directory browser for the web folder picker: immediate subdirectories
/// of `path` (defaults to the home directory), hidden entries excluded.
fn list_dirs(path: Option<String>) -> Result<DirListing, String> {
    let root = match path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty()) {
        Some(p) => std::path::PathBuf::from(p),
        None => std::path::PathBuf::from(home_dir()),
    };
    let root = root
        .canonicalize()
        .map_err(|e| format!("Cannot open directory '{}': {e}", root.display()))?;
    if !root.is_dir() {
        return Err(format!("Not a directory: {}", root.display()));
    }
    let mut entries = Vec::new();
    let read = std::fs::read_dir(&root)
        .map_err(|e| format!("Cannot read directory '{}': {e}", root.display()))?;
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false)
            || entry.path().is_dir();
        if !is_dir {
            continue;
        }
        entries.push(DirEntry {
            path: entry.path().to_string_lossy().into_owned(),
            name,
        });
    }
    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(DirListing {
        parent: root.parent().map(|p| p.to_string_lossy().into_owned()),
        path: root.to_string_lossy().into_owned(),
        entries,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every command name in the desktop `generate_handler!` list must be
    /// reachable through the RPC bridge (web-only commands may be extra).
    #[test]
    fn rpc_covers_every_tauri_command() {
        let lib = include_str!("../lib.rs");
        let start = lib.find("generate_handler![").expect("handler list");
        let end = lib[start..].find("])").expect("handler list end") + start;
        let mut missing = Vec::new();
        for line in lib[start..end].lines().skip(1) {
            let entry = line.trim().trim_end_matches(',');
            if entry.is_empty() {
                continue;
            }
            let name = entry.rsplit("::").next().unwrap_or(entry);
            if !COMMANDS.contains(&name) {
                missing.push(name.to_string());
            }
        }
        assert!(missing.is_empty(), "commands missing from web RPC: {missing:?}");
    }

    #[test]
    fn unknown_command_is_reported() {
        let ctx = AppCtx::headless(std::env::temp_dir(), None);
        let rt = tokio::runtime::Runtime::new().unwrap();
        let err = rt
            .block_on(dispatch(&ctx, "does_not_exist", json!({})))
            .unwrap_err();
        assert_eq!(err, UNKNOWN_COMMAND);
    }
}
