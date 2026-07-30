// Commands with no browser-server equivalent *at this layer*. Each either
// no-ops safely or throws a clear, actionable error so the web client
// degrades gracefully instead of crashing. NOTE: the vector store, project
// archive export/import, wiki-index rebuild, and the chat-agent runtime are
// now implemented server-side (see vectorstore.js / maintenance.js /
// agent.js); the local CLI chat transports (claude-code / codex-cli) are
// also implemented server-side now (see ../cli.js — the server runs on the
// host, so it spawns the same binaries the desktop app does). What remains
// here as a genuine web-mode limitation: the OS-level shell/status commands
// (proxy env, close behavior, clipper/API server status) — all safe no-ops or
// status strings. Embedded-image extraction, the vector store, archives, the
// chat-agent runtime (incl. runtime-orchestrated Deep Research), and the
// claude-code/codex-cli transports are all implemented server-side now.

function notSupported(feature) {
  return () => {
    throw new Error(`${feature} is not available in web-server mode (it requires the desktop app's native backend).`)
  }
}

const noop = () => null


// ── Desktop shell / status ────────────────────────────────────────────────
const shellCommands = {
  set_proxy_env: noop,
  set_close_behavior: noop,
  clip_server_status: () => "disabled (web-server mode)",
  api_server_status: () => "running (web-server mode)",
  api_server_reload_config: () => "ok",
  mcp_server_entry_path: () => "",
}

export const miscCommands = {
  ...shellCommands,
}
