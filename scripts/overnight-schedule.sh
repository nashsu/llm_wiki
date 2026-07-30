#!/usr/bin/env bash
# Unattended overnight driver for the llm_wiki web-client/server parity goal.
#
# Subcommands:
#   install    Add a crontab entry that fires `run` every hour during 22:00-07:59
#              Beijing time (the user's requested 22:00-08:00 window).
#   uninstall  Remove the crontab entry added by `install`.
#   status     Show current Beijing time, in-window?, lock held?, last run, the
#              installed crontab line, and a tail of the log.
#   run        The cron target. Applies the time guard + a flock (so an hourly
#              tick never stacks on a still-running session), then launches a
#              headless `codex exec` continuation of the parity goal.
#
# Test/override env (NOT set by the cron line; for manual verification only):
#   NIGHT_HOUR_OVERRIDE   Integer 0-23 used instead of the real Beijing hour,
#                         purely to exercise the time guard in tests.
#   NIGHT_FORCE=1         Bypass the time guard (run even outside the window).
#   NIGHT_RUN_CMD="..."   If set, execute this command instead of `codex exec`
#                         (proves the guard/lock/logging plumbing cheaply).
#   NIGHT_DRY=1           Print the resolved codex command and exit (no run).
#   NIGHT_SANDBOX=...     Override the codex sandbox mode (default:
#                         danger-full-access, which is prompt-free).
#   NIGHT_LOG_DIR=...     Override the runtime dir (default: <repo>/.overnight).
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MARKER="llm-wiki-overnight"
LOG_DIR="${NIGHT_LOG_DIR:-$REPO_ROOT/.overnight}"
LOG_FILE="$LOG_DIR/overnight.log"
LOCK_FILE="$LOG_DIR/overnight.lock"
LAST_FILE="$LOG_DIR/last-run.txt"
CRON_LOG="$LOG_DIR/cron.log"

# Cron fires with a minimal PATH (/usr/bin:/bin) that does NOT include the
# nvm-managed bin dir where `codex` and `node` live, so an unattended run would
# fail with "codex binary not found on PATH" (seen at the 23:00 tick). Discover
# and prepend those dirs at runtime so every subcommand — and the codex
# shebang (`#!/usr/bin/env node`) — resolve under cron. Idempotent.
augment_path() {
  command -v codex >/dev/null 2>&1 && command -v node >/dev/null 2>&1 && return 0
  local extra="" d
  if [ -n "${HOME:-}" ] && [ -d "$HOME/.nvm/versions/node" ]; then
    for d in "$HOME/.nvm/versions/node"/*/bin; do
      [ -x "$d/codex" ] && [ -x "$d/node" ] && extra="$d:$extra"
    done
  fi
  for d in /usr/local/bin /opt/homebrew/bin /snap/bin "${HOME:-}/.local/bin" "${HOME:-}/.cargo/bin"; do
    [ -d "$d" ] && extra="$extra:$d"
  done
  extra="${extra#:}"; extra="${extra%:}"
  [ -n "$extra" ] && export PATH="$extra:${PATH:-/usr/bin:/bin}"
  return 0
}
augment_path


# Active window = Beijing hours 22,23,0,1,2,3,4,5,6,7  (i.e. 22:00 .. 08:00).
in_window() {
  local h="$1"
  case "$h" in 22|23|0|1|2|3|4|5|6|7) return 0 ;; *) return 1 ;; esac
}

beijing_hour() {
  if [ -n "${NIGHT_HOUR_OVERRIDE:-}" ]; then echo "$NIGHT_HOUR_OVERRIDE"; return; fi
  TZ=Asia/Shanghai date +%-H
}

log() { printf '%s  %s\n' "$(TZ=Asia/Shanghai date '+%F %T %Z')" "$*" >> "$LOG_FILE"; }

ensure_dirs() { mkdir -p "$LOG_DIR"; }

cron_line() {
  # Fires at the top of each in-window hour. The marker token appears on the
  # command line so `grep -v $MARKER` cleanly removes it on reinstall.
  printf '0 22-23,0-7 * * * %s=1 %s run >> %s 2>&1 # %s\n' \
    "LLM_WIKI_NIGHT" "$SCRIPT_DIR/overnight-schedule.sh" "$CRON_LOG" "$MARKER"
}

cmd_install() {
  ensure_dirs
  local line tmp existing
  line="$(cron_line)"
  existing="$(crontab -l 2>/dev/null | grep -v "$MARKER" || true)"
  tmp="$(mktemp)"
  if [ -n "$existing" ]; then printf '%s\n' "$existing" > "$tmp"; else : > "$tmp"; fi
  printf '# %s schedule (managed by scripts/overnight-schedule.sh)\n' "$MARKER" >> "$tmp"
  printf '%s\n' "$line" >> "$tmp"
  crontab "$tmp"; rm -f "$tmp"
  echo "Installed overnight crontab entry:"
  crontab -l 2>/dev/null | grep "$MARKER"
  echo "Window: Beijing 22:00-08:00 (fires hourly at 22,23,0..7). Logs: $LOG_FILE"
}

cmd_uninstall() {
  local existing
  existing="$(crontab -l 2>/dev/null | grep -v "$MARKER" || true)"
  if [ -z "$existing" ]; then crontab -r 2>/dev/null || true
  else printf '%s\n' "$existing" | crontab -; fi
  echo "Removed overnight crontab entry (if any)."
}

cmd_status() {
  ensure_dirs
  local h; h="$(beijing_hour)"
  echo "Beijing time : $(TZ=Asia/Shanghai date '+%F %H:%M:%S %A')"
  if in_window "$h"; then echo "In window    : YES (hour=$h)"; else echo "In window    : NO  (hour=$h)"; fi
  if ( flock -n 9 ) 9>"$LOCK_FILE" 2>/dev/null; then echo "Lock         : FREE"; else echo "Lock         : HELD (a run is active)"; fi
  echo "Last run     : $(cat "$LAST_FILE" 2>/dev/null || echo '(none)')"
  echo "Crontab line :"
  crontab -l 2>/dev/null | grep "$MARKER" || echo "  (not installed)"
  echo "Log tail     :"
  tail -n 8 "$LOG_FILE" 2>/dev/null | sed 's/^/  /' || echo "  (empty)"
}

# The continuation prompt is self-contained: a scheduled run has no memory of
# any interactive session, so it must re-derive state from the worktree.
read -r -d '' PROMPT <<'PROMPT' || true
You are continuing UNATTENDED work in the llm_wiki repo (cwd = repo root). Work from evidence, never memory.

PRIMARY OBJECTIVE (product): one user must be able to use the DESKTOP app and the WEB app against ONE backend / ONE set of user data. Anything added or edited on one client (wiki pages, sources, chat, reviews, ingest queue, settings, recents) must be usable on the other. Do NOT rebuild the desktop app — reuse everything it has. The web app (packages/server/ + src/web/ + vite.web.config.ts) must mirror as many desktop features as possible for a streamlined experience. Everything must be FULLY WORKING and SHIPPABLE.

Read first: RUNBOOK.md (esp. "One backend, shared user data", the feature matrix, and "Remaining parity delta"). Then grep the server for residual gaps: `notSupported(`, `: noop`, the string "not available in web-server mode" in packages/server/src/commands/*.js, and any Tauri command in src-tauri/src/commands with no Node equivalent in packages/server/src/commands. Confirm src/web shims cover every @tauri-apps import.

STATUS_AS_OF_2026-07-29_0430 (read this first, it supersedes stale priority hints): command-layer parity is COMPLETE — every one of the 60 commands the React frontend invokes is implemented in packages/server/src (0 throwing stubs; `notSupported` has no call sites), the 2 web-only opener cmds are registered (75 total), `/api/v1`+MCP interop is done (27/27 + 17/17 real client), and the cross-client source-snapshot/queue interop is done AND gated by /tmp/verify-filesync-shared.mjs (8/8, required in /tmp/gates.sh). So your `notSupported(`/`noop`/`not available` greps will now match NOTHING — do NOT chase phantom gaps. The matrix's only ❌ (Chrome clipper + autostart) is genuinely browser-impossible (keep documented). The remaining VERIFIABLE parity work, in priority order: (1) per-command `shell.exec` APPROVAL flow — the desktop runtime emits a `userInputRequired` confirm request and parks the run until the user approves (SHELL_APPROVAL_REQUIRED_OBSERVATION / record_loop_tool_rejection in runtime.rs); the web currently only has the all-or-nothing `LLM_WIKI_ALLOW_SHELL` env gate, which is a parity AND safety gap. Port the pause/resume handshake over the streaming path (`agent_start_turn_stream` emits the request; add a small POST endpoint the frontend's existing userInputRequired UI resolves; run resumes) — verifiable with a mock LLM that issues a `shell.exec` tool call. (2) a headless Playwright UI e2e that opens a project via the server-backed picker and renders the file tree + a wiki page with ZERO console/page errors (proves the streamlined UX end-to-end, not just boot). KEEP HUFF/CDIC `.mobi` as a documented limitation — do NOT ship a blind decoder (no fixture exists here to verify it). If you implement (1), update the `Agent shell.exec` matrix row from ⚠️ to ✅ and strike the relevant delta note; always leave /tmp/gates.sh GATES_OK.
Pick the single highest-value remaining item and implement it for real, faithfully porting the Rust contract (arg names, return shapes, error semantics) so the unmodified React frontend works. Priorities, in order: (1) anything that breaks the shared-data promise; (2) parity items that are verifiable without a real LLM key — agent skills scanning (filesystem scan), graph.search + graph-boosted search (port the pure-TS src/lib/graph-relevance.ts into the server search + agent tool), Claude-Code/Codex-CLI chat backends (the server runs on the host, so it CAN spawn these CLIs — port src/lib/claude-cli-transport.ts & codex-cli-transport.ts to the server), Office embedded-image extraction (unzip word/media etc.); (3) the rest of the matrix. If a feature is genuinely impossible in a browser (OS file-manager reveal, autostart, Chrome clipper), keep it a documented no-op AND record that in the RUNBOOK matrix — never leave a throwing stub. Likewise, never ship a from-scratch binary decoder (HUFF/CDIC .mobi, OLE2 .doc) that you cannot verify with a real fixture+test on this host — an untested decoder that could throw on real files is WORSE than the documented convert-first error (the desktop ingest layer also tolerates extraction failure gracefully).

VERIFY before stopping (all must pass; recreate any harness missing from /tmp — /tmp is volatile between runs):
 - `node --check` every packages/server/src/**/*.js.
 - Shared-data harness (run with the server on a free port): point the server at a fake "desktop" store via LLM_WIKI_STORE_FILE (or test auto-detect by setting HOME/XDG_DATA_HOME to a temp dir with a marker app-state.json; use LLM_WIKI_NO_SHARE=1 for isolation cases). Assert: web reads a desktop-written key live; a web key-level write does NOT clobber an unrelated desktop key in the raw file; an out-of-band desktop edit is seen by the web with NO restart (mtime); recents/registry are shared; and the live-sync watcher emits `project://files-changed` for an out-of-band wiki edit while SUPPRESSING the server's own writes (app-write-ignore) and EXCLUDING raw/sources paths. (/api/health exposes store.shared/source.)
 - Agent harness: stand up a tiny mock OpenAI-compatible server in /tmp, write a chat config into the server's store pointing at it (set LLM_WIKI_NO_SHARE=1 so auto-detect can't grab a real desktop store), drive agent_start_turn AND agent_start_turn_stream, assert the exact agent-event sequence (toolStart -> referenceAdded -> toolEnd -> messageDelta -> done) and the non-stream BackendAgentResponse shape, plus cancel + unknown-project error.
 - Headless browser boot: build dist-web (npm run build:web), serve via the server with an EMPTY store (LLM_WIKI_NO_SHARE=1 + fresh LLM_WIKI_DATA_DIR), drive Chromium (playwright-core + the chromium already under ~/.cache/ms-playwright; install playwright-core JS into /tmp if missing — do NOT download a browser), assert the welcome screen renders with ZERO pageerror / console error / failed request.
 - `npx tsc --build` clean.

Keep RUNBOOK.md accurate (feature matrix + shared-data section + env vars). Add build/runtime artifacts to .gitignore. Do NOT commit, do NOT push, do NOT mark any goal complete. Leave a GREEN working tree: every gate above passing. Do one coherent, verified increment, then stop — the scheduler resumes you later.

PROMPT

resolved_codex_cmd() {
  local codex_bin sandbox
  codex_bin="$(command -v codex || true)"
  if [ -z "$codex_bin" ]; then echo "" ; return 1; fi
  sandbox="${NIGHT_SANDBOX:-danger-full-access}"
  # -C sets the working root to the repo (cron's cwd is $HOME, not the repo,
  #   which made codex abort with "Not inside a trusted directory").
  # --skip-git-repo-check bypasses the trusted-directory gate for automation.
  # --ephemeral avoids accumulating session files across nightly runs.
  printf '%s exec -s %s -C %s --skip-git-repo-check --ephemeral -' \
    "$codex_bin" "$sandbox" "$REPO_ROOT"
}

cmd_run() {
  ensure_dirs
  local h; h="$(beijing_hour)"
  if [ "${NIGHT_FORCE:-0}" != "1" ] && ! in_window "$h"; then
    log "SKIP: hour=$h outside 22:00-08:00 window (set NIGHT_FORCE=1 to override)"
    echo "overnight: skipped (out of window, hour=$h)"
    return 0
  fi

  # Non-blocking lock: if a previous hourly tick is still running, skip.
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    log "SKIP: another run holds the lock"
    echo "overnight: skipped (lock held)"
    return 0
  fi

  log "START run (hour=$h)"
  printf '%s start\n' "$(TZ=Asia/Shanghai date '+%F %T %Z')" > "$LAST_FILE"

  # Run from the repo root so codex's cwd (and -C) is the project, and so the
  # continuation prompt's relative paths (packages/server/src, src/web, ...) resolve.
  if ! cd "$REPO_ROOT" 2>/dev/null; then
    log "ERROR: cannot cd to repo root $REPO_ROOT"
    printf '%s end (bad cwd)\n' "$(TZ=Asia/Shanghai date '+%F %T %Z')" > "$LAST_FILE"
    return 1
  fi
  log "cwd=$(pwd)"

  if [ -n "${NIGHT_RUN_CMD:-}" ]; then
    log "using NIGHT_RUN_CMD override"
    if bash -c "$NIGHT_RUN_CMD" >> "$LOG_FILE" 2>&1; then
      log "NIGHT_RUN_CMD exit=0"
    else
      log "NIGHT_RUN_CMD exit=$?"
    fi
    printf '%s end (override)\n' "$(TZ=Asia/Shanghai date '+%F %T %Z')" > "$LAST_FILE"
    return 0
  fi

  local cmd
  if ! cmd="$(resolved_codex_cmd)"; then
    log "ERROR: codex binary not found on PATH"
    printf '%s end (no codex)\n' "$(TZ=Asia/Shanghai date '+%F %T %Z')" > "$LAST_FILE"
    return 1
  fi

  if [ "${NIGHT_DRY:-0}" = "1" ]; then
    log "DRY: $cmd  < <prompt ${#PROMPT} bytes via stdin>"
    echo "overnight dry-run command: $cmd  (prompt ${#PROMPT} bytes on stdin)"
    printf '%s end (dry)\n' "$(TZ=Asia/Shanghai date '+%F %T %Z')" > "$LAST_FILE"
    return 0
  fi

  # NIGHT_PROMPT (test hook only) overrides the parity prompt so the real
  # codex code path can be exercised cheaply (e.g. trust-gate verification).
  local prompt_text="$PROMPT"
  if [ -n "${NIGHT_PROMPT:-}" ]; then prompt_text="$NIGHT_PROMPT"; log "using NIGHT_PROMPT override (${#prompt_text} bytes)"; fi
  log "EXEC: $cmd  < <prompt ${#prompt_text} bytes via stdin>"
  local rc=0
  # Feed the prompt on stdin (`-`); codex appends nothing else. Capture all
  # output to the log so overnight activity is auditable.
  printf '%s' "$prompt_text" | $cmd >> "$LOG_FILE" 2>&1 || rc=$?
  log "END codex exec rc=$rc"
  printf '%s end rc=%s\n' "$(TZ=Asia/Shanghai date '+%F %T %Z')" "$rc" > "$LAST_FILE"
  return 0
}

case "${1:-}" in
  install)   cmd_install ;;
  uninstall) cmd_uninstall ;;
  status)    cmd_status ;;
  run)       cmd_run ;;
  ""|-h|--help)
    sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
    ;;
  *) echo "unknown subcommand: $1 (use install|uninstall|status|run)" >&2; exit 2 ;;
esac
