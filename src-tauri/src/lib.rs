//! Crate root.
//!
//! The command layer (`commands/`, `agent/`, `app_commands`) is host-agnostic
//! and talks to the host through [`app_ctx::AppCtx`]. Two hosts exist:
//!
//! * the Tauri desktop application (`desktop` feature, [`run`]);
//! * the headless web server (`server` feature, [`web::main`]), which serves
//!   the same React frontend over HTTP and bridges its `invoke()` calls to
//!   the same command functions.

pub mod agent;
pub mod api_server;
pub mod app_commands;
pub mod app_ctx;
pub mod clip_server;
pub mod commands;
pub mod connectors;
pub mod cors;
pub mod panic_guard;
pub mod proxy;
pub mod rt;
pub mod server_bind;
#[cfg(feature = "desktop")]
mod tray;
pub mod types;
pub mod web;

use app_ctx::AppCtx;

/// Register the singletons every host needs before serving requests.
pub fn register_shared_state(ctx: &AppCtx) {
    // Registry of running `claude` / `codex` subprocesses, keyed by the
    // frontend-generated stream id. Populated by *_cli_spawn, drained on
    // process exit or by *_cli_kill.
    ctx.manage(commands::claude_cli::ClaudeCliState::default());
    ctx.manage(commands::codex_cli::CodexCliState::default());
    ctx.manage(commands::file_sync::FileSyncState::default());
    ctx.manage(agent::session::AgentSessionStore::default());
    ctx.manage(agent::cancel::AgentCancellationRegistry::default());
}

#[cfg(feature = "desktop")]
mod desktop {
    use super::*;
    use std::sync::Mutex;
    use tauri::Manager;

    pub struct CloseBehaviorState(pub Mutex<String>);
    pub struct TrayAvailabilityState(pub Mutex<bool>);

    #[tauri::command]
    fn set_close_behavior(
        value: String,
        state: tauri::State<'_, CloseBehaviorState>,
    ) -> Result<String, String> {
        let normalized = match value.as_str() {
            "ask" | "minimize" | "exit" => value,
            other => return Err(format!("Invalid close behavior: {other}")),
        };
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "Close behavior state is unavailable".to_string())?;
        *guard = normalized.clone();
        Ok(normalized)
    }

    fn close_behavior<R: tauri::Runtime>(window: &tauri::Window<R>) -> String {
        window
            .state::<CloseBehaviorState>()
            .0
            .lock()
            .map(|value| value.clone())
            .unwrap_or_else(|_| "minimize".to_string())
    }

    fn tray_available<R: tauri::Runtime>(window: &tauri::Window<R>) -> bool {
        window
            .state::<TrayAvailabilityState>()
            .0
            .lock()
            .map(|value| *value)
            .unwrap_or(false)
    }

    #[cfg_attr(mobile, tauri::mobile_entry_point)]
    pub fn run() {
        apply_linux_webkit_compat_env();

        tauri::Builder::default()
            .plugin(tauri_plugin_opener::init())
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_store::Builder::default().build())
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                None::<Vec<&str>>,
            ))
            // Rust-backed fetch so third-party LLM APIs that reject
            // browser-origin headers via CORS preflight (MiniMax, Volcengine
            // Ark's api/coding/v3, etc.) still work. Requests leave the app
            // from Rust, never the webview.
            .plugin(tauri_plugin_http::init())
            .setup(|app| {
                // Let the PDF extractor find the bundled pdfium dynamic
                // library via Tauri's platform-correct resource path.
                if let Ok(dir) = app.path().resource_dir() {
                    commands::fs::set_resource_dir_hint(dir);
                }
                // Apply user-configured global HTTP proxy by setting
                // HTTP_PROXY / HTTPS_PROXY / NO_PROXY env vars BEFORE
                // any HTTP request is made. tauri-plugin-http's reqwest
                // client reads these on first construction. Lives next
                // to the resource-dir hint so the proxy applies to
                // everything: LLM, embedding, update check, deep
                // research, captioning. See src-tauri/src/proxy.rs.
                if let Ok(dir) = app.path().app_data_dir() {
                    let store_path = dir.join("app-state.json");
                    eprintln!("[proxy] reading from {}", store_path.display());
                    if let Some(cfg) = proxy::read_proxy_config_from_store(&store_path) {
                        let summary = proxy::apply_proxy_env(&cfg);
                        eprintln!("[proxy] {summary}");
                    } else {
                        eprintln!("[proxy] no proxyConfig in store, requests go direct");
                    }
                } else {
                    eprintln!("[proxy] could not resolve app_data_dir");
                }
                // Runtime-agnostic context shared by IPC commands, the local
                // HTTP API, the clip server and (optionally) the web server.
                let ctx = AppCtx::desktop(app.handle());
                app.manage(ctx.clone());
                register_shared_state(&ctx);
                app.manage(CloseBehaviorState(Mutex::new("minimize".to_string())));
                app.manage(TrayAvailabilityState(Mutex::new(false)));
                // Start the API before optional desktop integrations so the
                // backend is reachable if tray setup or another integration fails.
                clip_server::start_clip_server(ctx.clone());
                api_server::start_api_server(ctx.clone());
                web::maybe_start_embedded(ctx.clone());
                connectors::scheduler::start(ctx.clone());
                let tray_available = match tray::create_tray(app.handle()) {
                    Ok(()) => true,
                    Err(err) => {
                        eprintln!("[tray] system tray unavailable, continuing without it: {err}");
                        false
                    }
                };
                match app.state::<TrayAvailabilityState>().0.lock() {
                    Ok(mut state) => {
                        *state = tray_available;
                    }
                    Err(err) => {
                        eprintln!("[tray] failed to update tray availability state: {err}");
                    }
                }
                Ok(())
            })
            .invoke_handler(tauri::generate_handler![
                commands::fs::read_file,
                commands::fs::write_file,
                commands::fs::write_file_base64,
                commands::fs::write_file_atomic,
                commands::fs::apply_text_selection_edit,
                commands::fs::create_missing_wiki_page,
                commands::file_history::list_file_history,
                commands::file_history::restore_file_history,
                commands::file_history::get_file_history_stats,
                commands::file_history::get_file_history_settings,
                commands::file_history::set_file_history_settings,
                commands::file_history::clear_file_history,
                commands::fs::list_directory,
                commands::fs::copy_file,
                commands::fs::copy_directory,
                commands::fs::preprocess_file,
                commands::fs::delete_file,
                commands::fs::find_related_wiki_pages,
                commands::fs::create_directory,
                commands::fs::file_exists,
                commands::fs::get_file_modified_time,
                commands::fs::get_file_size,
                commands::fs::get_file_md5,
                commands::fs::read_file_as_base64,
                commands::project::create_project,
                commands::project::open_project,
                commands::project::open_project_folder,
                commands::project::open_path_in_project,
                commands::project_maintenance::export_project_archive,
                commands::project_maintenance::import_project_archive,
                commands::project_maintenance::rebuild_wiki_index,
                commands::search::search_project,
                commands::search::embedding_fetch,
                commands::search::embedding_fetch_batch,
                commands::search::get_page_links,
                commands::external_search::web_search,
                commands::external_search::anytxt_search,
                app_commands::clip_server_status,
                app_commands::api_server_status,
                app_commands::api_server_reload_config,
                app_commands::agent_start_turn,
                app_commands::agent_start_turn_stream,
                app_commands::agent_cancel_turn,
                app_commands::agent_get_session,
                app_commands::agent_list_sessions,
                agent::skills::agent_list_skills,
                app_commands::mcp_server_entry_path,
                commands::vectorstore::vector_upsert,
                commands::vectorstore::vector_search,
                commands::vectorstore::vector_delete,
                commands::vectorstore::vector_count,
                commands::vectorstore::vector_upsert_chunks,
                commands::vectorstore::vector_search_chunks,
                commands::vectorstore::vector_delete_page,
                commands::vectorstore::vector_count_chunks,
                commands::vectorstore::vector_clear_chunks,
                commands::vectorstore::vector_optimize_chunks,
                commands::vectorstore::vector_legacy_row_count,
                commands::vectorstore::vector_drop_legacy,
                commands::claude_cli::claude_cli_detect,
                commands::claude_cli::claude_cli_spawn,
                commands::claude_cli::claude_cli_kill,
                commands::codex_cli::codex_cli_detect,
                commands::codex_cli::codex_cli_spawn,
                commands::codex_cli::codex_cli_kill,
                commands::extract_images::extract_pdf_images_cmd,
                commands::extract_images::extract_office_images_cmd,
                commands::extract_images::extract_and_save_pdf_images_cmd,
                commands::extract_images::extract_and_save_office_images_cmd,
                commands::file_sync::start_project_file_watcher,
                commands::file_sync::stop_project_file_watcher,
                commands::file_sync::rescan_project_files,
                commands::file_sync::get_file_change_queue,
                commands::file_sync::retry_file_change_task,
                commands::file_sync::ignore_file_change_task,
                app_commands::set_proxy_env,
                connectors::commands::connector_descriptors,
                connectors::commands::connector_list,
                connectors::commands::connector_save,
                connectors::commands::connector_delete,
                connectors::commands::connector_test,
                connectors::commands::connector_sync,
                connectors::commands::connector_reset,
                connectors::commands::connector_oauth_start,
                connectors::commands::connector_oauth_disconnect,
                set_close_behavior,
            ])
            .on_window_event(|window, event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let behavior = close_behavior(window);
                    let win = window.clone();
                    let app = window.app_handle().clone();
                    match behavior.as_str() {
                        "exit" => {
                            tauri::async_runtime::spawn(async move {
                                let _ = win.destroy();
                                app.exit(0);
                            });
                        }
                        "minimize" => {
                            if tray_available(window) {
                                let _ = window.hide();
                            } else {
                                let _ = window.minimize();
                            }
                        }
                        _ => {
                            tauri::async_runtime::spawn(async move {
                                use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
                                let confirmed = app
                                    .dialog()
                                    .message(
                                        "Quit LLM Wiki? Choose Quit to exit. Choose Hide Window to keep background features running.",
                                    )
                                    .title("LLM Wiki")
                                    .buttons(MessageDialogButtons::OkCancelCustom(
                                        "Quit".to_string(),
                                        "Hide Window".to_string(),
                                    ))
                                    .kind(tauri_plugin_dialog::MessageDialogKind::Warning)
                                    .blocking_show();

                                if confirmed {
                                    let _ = win.destroy();
                                    app.exit(0);
                                } else {
                                    let _ = win.hide();
                                }
                            });
                        }
                    }
                }
            })
            .build(tauri::generate_context!())
            .expect("error while building tauri application")
            .run(|app, event| {
                #[cfg(target_os = "macos")]
                if let tauri::RunEvent::Reopen {
                    has_visible_windows,
                    ..
                } = event
                {
                    if !has_visible_windows {
                        use tauri::Manager;
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                }
                let _ = (app, event); // suppress unused warnings on non-macOS
            });
    }

    #[cfg(target_os = "linux")]
    fn apply_linux_webkit_compat_env() {
        // WebKitGTK can crash or withdraw its window on some Wayland/XWayland
        // stacks unless accelerated render paths are disabled before the WebView
        // is created. Keep these as Linux-only defaults and do not override an
        // explicit user setting so advanced users and packagers can opt back into
        // the platform default if their stack supports it.
        if std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_none() {
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        }
        // Some WebKitGTK/Mesa combinations still attempt the DMA-BUF renderer
        // even with accelerated compositing disabled. In an AppImage running
        // through XWayland that can withdraw the native window while leaving the
        // web and network processes alive. Respect explicit packager overrides.
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    #[cfg(not(target_os = "linux"))]
    fn apply_linux_webkit_compat_env() {}
}

#[cfg(feature = "desktop")]
pub use desktop::run;
