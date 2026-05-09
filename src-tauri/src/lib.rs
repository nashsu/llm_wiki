mod clip_server;
mod commands;
mod panic_guard;
mod proxy;
mod types;

use panic_guard::run_guarded;
use serde::Serialize;
use std::path::{Path, PathBuf};

#[tauri::command]
fn clip_server_status() -> String {
    run_guarded("clip_server_status", || {
        Ok(clip_server::get_daemon_status().to_string())
    })
    .unwrap_or_else(|e| format!("error: {e}"))
}

/// Apply a proxy configuration to the process env immediately, so the
/// next outbound HTTP request picks it up without needing the user to
/// restart the app. tauri-plugin-http builds a fresh
/// `reqwest::ClientBuilder` per fetch and reqwest's `auto_sys_proxy`
/// re-reads HTTP_PROXY / HTTPS_PROXY / NO_PROXY each time, so updating
/// these env vars is sufficient to flip the proxy on/off live.
///
/// Returns the same human-readable summary `apply_proxy_env` produces
/// for logging.
#[tauri::command]
fn set_proxy_env(config: proxy::ProxyConfig) -> String {
    let summary = proxy::apply_proxy_env(&config);
    eprintln!("[proxy] live update: {summary}");
    summary
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct McpServerConfig {
    script_path: String,
    codex_command: String,
    json_config: String,
}

fn normalize_display_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn shell_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\\\""))
}

fn build_mcp_config(script_path: &Path) -> Result<McpServerConfig, String> {
    let script_path = normalize_display_path(script_path);
    let codex_command = format!(
        "codex mcp add llmwiki -- node {}",
        shell_quote(&script_path)
    );
    let json_config = serde_json::to_string_pretty(&serde_json::json!({
        "mcpServers": {
            "llmwiki": {
                "command": "node",
                "args": [script_path.clone()],
            },
        },
    }))
    .map_err(|e| format!("Failed to build MCP JSON config: {e}"))?;

    Ok(McpServerConfig {
        script_path,
        codex_command,
        json_config,
    })
}

fn find_mcp_server_script() -> Result<PathBuf, String> {
    let manifest_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf);
    let cwd = std::env::current_dir().ok();

    let mut candidates = Vec::new();
    if let Some(root) = manifest_root {
        candidates.push(root.join("mcp-server").join("llmwiki-mcp.js"));
    }
    if let Some(dir) = cwd {
        candidates.push(dir.join("mcp-server").join("llmwiki-mcp.js"));
        candidates.push(dir.join("..").join("mcp-server").join("llmwiki-mcp.js"));
    }

    for candidate in candidates {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    Err("Could not find mcp-server/llmwiki-mcp.js. Run from the LLM Wiki source tree or install the MCP server file next to this app.".to_string())
}

#[tauri::command]
fn mcp_server_config() -> Result<McpServerConfig, String> {
    run_guarded("mcp_server_config", || {
        let script = find_mcp_server_script()?;
        build_mcp_config(&script)
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    clip_server::start_clip_server();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        // Rust-backed fetch so third-party LLM APIs that reject
        // browser-origin headers via CORS preflight (MiniMax, Volcengine
        // Ark's api/coding/v3, etc.) still work. Requests leave the app
        // from Rust, never the webview.
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            // Let the PDF extractor find the bundled pdfium dynamic
            // library via Tauri's platform-correct resource path.
            use tauri::Manager;
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
            // Registry of running `claude` subprocesses, keyed by the
            // frontend-generated stream id. Populated by claude_cli_spawn,
            // drained on process exit or by claude_cli_kill.
            app.manage(commands::claude_cli::ClaudeCliState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::fs::read_file,
            commands::fs::write_file,
            commands::fs::list_directory,
            commands::fs::copy_file,
            commands::fs::copy_directory,
            commands::fs::preprocess_file,
            commands::fs::delete_file,
            commands::fs::find_related_wiki_pages,
            commands::fs::create_directory,
            commands::fs::file_exists,
            commands::fs::read_file_as_base64,
            commands::project::create_project,
            commands::project::open_project,
            clip_server_status,
            commands::vectorstore::vector_upsert,
            commands::vectorstore::vector_search,
            commands::vectorstore::vector_delete,
            commands::vectorstore::vector_count,
            commands::vectorstore::vector_upsert_chunks,
            commands::vectorstore::vector_search_chunks,
            commands::vectorstore::vector_delete_page,
            commands::vectorstore::vector_count_chunks,
            commands::vectorstore::vector_legacy_row_count,
            commands::vectorstore::vector_drop_legacy,
            commands::claude_cli::claude_cli_detect,
            commands::claude_cli::claude_cli_spawn,
            commands::claude_cli::claude_cli_kill,
            commands::extract_images::extract_pdf_images_cmd,
            commands::extract_images::extract_office_images_cmd,
            commands::extract_images::extract_and_save_pdf_images_cmd,
            commands::extract_images::extract_and_save_office_images_cmd,
            mcp_server_config,
            set_proxy_env,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                #[cfg(target_os = "macos")]
                {
                    let _ = window.hide();
                    api.prevent_close();
                }

                #[cfg(not(target_os = "macos"))]
                {
                    use tauri::Manager;
                    api.prevent_close();
                    let win = window.clone();
                    let app = window.app_handle().clone();
                    tauri::async_runtime::spawn(async move {
                        use tauri_plugin_dialog::DialogExt;
                        let confirmed = app
                            .dialog()
                            .message("Are you sure you want to quit LLM Wiki?")
                            .title("Confirm Exit")
                            .kind(tauri_plugin_dialog::MessageDialogKind::Warning)
                            .blocking_show();

                        if confirmed {
                            let _ = win.destroy();
                        }
                    });
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { has_visible_windows, .. } = event {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_config_contains_node_and_script_path() {
        let cfg = build_mcp_config(Path::new("D:/Dev/llm_wiki/mcp-server/llmwiki-mcp.js"))
            .expect("config should build");

        assert!(cfg.codex_command.contains("node"));
        assert!(cfg.codex_command.contains("mcp-server/llmwiki-mcp.js"));
        assert!(cfg.json_config.contains("\"command\": \"node\""));
        assert!(cfg.json_config.contains("mcp-server/llmwiki-mcp.js"));
    }
}
