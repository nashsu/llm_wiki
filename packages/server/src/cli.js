// External CLI chat transports: Claude Code CLI and Codex CLI.
//
// Faithful Node port of the desktop's Rust subprocess transports
// (src-tauri/src/commands/claude_cli.rs, codex_cli.rs, cli_resolver.rs).
// The web server runs on the user's host, so — exactly like the desktop
// app — it can spawn the locally-installed `claude` / `codex` binaries and
// treat them as text-completion engines. This lets a user reuse an existing
// Claude Code subscription or Codex login from the browser client without a
// separate API key.
//
// Contract with the unmodified frontend (src/lib/claude-cli-transport.ts,
// codex-cli-transport.ts):
//   - claude_cli_detect / codex_cli_detect  -> { installed, version, path, error }
//   - claude_cli_spawn { streamId, model, messages, isolateLocalConfig, workingDirectory }
//       streams each stdout line as event  `claude-cli:{streamId}`  and a final
//       `claude-cli:{streamId}:done` with { code, stderr }.
//   - codex_cli_spawn { streamId, model, prompt, isolateLocalConfig, timeoutMinutes, workingDirectory }
//       streams each stdout line as event  `codex-cli:{streamId}`  and a final
//       `codex-cli:{streamId}:done` with { code, stderr, stdout }.
//   - claude_cli_kill / codex_cli_kill { streamId } -> SIGKILL the child.
//
// Events are broadcast over the shared SSE bus (events.js#emit), which the
// browser's @tauri-apps/api/event `listen` shim demultiplexes by name — the
// same mechanism the agent runtime uses.

import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { emit } from "./events.js"

// ── CLI resolution (port of cli_resolver.rs) ──────────────────────────────

const LOGIN_SHELL_TIMEOUT_MS = 3000
const PATH_MARKER = "\x1e"
// printf emits the marker-delimited PATH so we can ignore shell rc banners:
//   printf '\036PATH=%s\036\n' "$PATH"   (036 octal == 0x1e)
const PRINTF_CMD = "printf '\\036PATH=%s\\036\\n' \"$PATH\""

const commandCache = new Map()
let shellPathCache // undefined = unresolved, null = none, string = PATH
let childPathCache // undefined = unresolved, null = none, string = merged PATH

/** Parse the marker-delimited PATH line out of a login shell's output. */
export function parseShellPathOutput(stdout) {
  for (const rawLine of String(stdout).split("\n")) {
    const line = rawLine.replace(/\r$/, "")
    if (!line.startsWith(PATH_MARKER)) continue
    const rest = line.slice(1)
    if (!rest.endsWith(PATH_MARKER)) continue
    const val = rest.slice(0, -1)
    if (!val.startsWith("PATH=")) continue
    const p = val.slice("PATH=".length)
    if (p) return p
  }
  return null
}

/**
 * Resolve the user's login-shell PATH (cached). GUI/cron/daemon launches
 * inherit a minimal PATH that omits version-manager dirs (nvm, homebrew,
 * cargo); node-shim CLIs like `codex` (#!/usr/bin/env node) need that PATH
 * both to be found and to run. Returns null when there is nothing to add.
 */
export function loginShellPath() {
  if (shellPathCache !== undefined) return shellPathCache
  const shell = process.env.SHELL || "/bin/sh"
  const shellName = path.basename(shell).toLowerCase()
  // Minimal /bin/sh variants often do not support `-l`; use `-ic` for them
  // while bash/zsh/fish keep the login-shell (`-ilc`) PATH. `-i` is
  // intentional: many version managers only update PATH from interactive rc.
  const args = ["sh", "dash", "ash"].includes(shellName)
    ? ["-ic", PRINTF_CMD]
    : ["-ilc", PRINTF_CMD]
  let result = null
  try {
    const r = spawnSync(shell, args, {
      timeout: LOGIN_SHELL_TIMEOUT_MS,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    if (r && r.stdout) result = parseShellPathOutput(r.stdout)
  } catch {
    result = null
  }
  shellPathCache = result
  return result
}

/** PATH to hand a spawned CLI: login-shell PATH prepended to the inherited
 *  one (cached), or null when there is nothing to add. */
export function childPathEnv() {
  if (childPathCache !== undefined) return childPathCache
  const sp = loginShellPath()
  if (!sp) {
    childPathCache = null
    return null
  }
  const inherited = process.env.PATH
  childPathCache = inherited ? `${sp}${path.delimiter}${inherited}` : sp
  return childPathCache
}

function isExecutable(p) {
  try {
    const st = fs.statSync(p)
    if (!st.isFile()) return false
    fs.accessSync(p, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function whichInDirs(command, pathStr) {
  if (!pathStr) return null
  for (const dir of pathStr.split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, command)
    if (isExecutable(candidate)) return candidate
  }
  return null
}

/** Locate a CLI on PATH (inherited, then login-shell fallback), cached. */
export function whichCommand(command) {
  const cached = commandCache.get(command)
  if (cached) {
    if (isExecutable(cached)) return cached
    commandCache.delete(command)
  }
  let found = whichInDirs(command, process.env.PATH)
  if (!found) found = whichInDirs(command, loginShellPath())
  if (found) commandCache.set(command, found)
  return found
}

function findCliCommand(command) {
  const found = whichCommand(command)
  if (!found) throw new Error(`\`${command}\` not found on PATH`)
  return found
}

/** Env for a spawned CLI: inherited env with PATH upgraded to include the
 *  login-shell PATH (so node-shim shebangs resolve under a GUI/daemon). */
function spawnEnv() {
  const p = childPathEnv()
  return p ? { ...process.env, PATH: p } : process.env
}

// ── Detection ─────────────────────────────────────────────────────────────

function runVersionCheck(binPath, command) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (r) => { if (!settled) { settled = true; resolve(r) } }
    let child
    try {
      child = spawn(binPath, ["--version"], { env: spawnEnv(), stdio: ["ignore", "pipe", "pipe"] })
    } catch (e) {
      return finish({ installed: false, version: null, path: binPath, error: `Failed to spawn \`${command}\`: ${e.message}` })
    }
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL") } catch { /* already gone */ }
      finish({ installed: false, version: null, path: binPath, error: `\`${command} --version\` timed out after 3s` })
    }, 3000)
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (d) => { stdout += d })
    child.stderr.on("data", (d) => { stderr += d })
    child.once("error", (e) => {
      clearTimeout(timer)
      finish({ installed: false, version: null, path: binPath, error: `Failed to spawn \`${command}\`: ${e.message}` })
    })
    child.once("close", (code) => {
      clearTimeout(timer)
      if (code === 0) {
        finish({ installed: true, version: stdout.trim(), path: binPath, error: null })
        return
      }
      const errText = stderr.trim()
      let error
      if (command === "claude" && /quarantine|damaged/i.test(errText)) {
        // macOS Gatekeeper quarantine has a predictable, actionable fix.
        error = `Binary quarantined — try: xattr -d com.apple.quarantine ${binPath}`
      } else if (!errText) {
        error = `\`${command} --version\` exited with ${code == null ? "signal" : "code " + code}`
      } else {
        error = errText
      }
      finish({ installed: false, version: null, path: binPath, error })
    })
  })
}

async function detectCli(command) {
  const binPath = whichCommand(command)
  if (!binPath) {
    return { installed: false, version: null, path: null, error: `\`${command}\` not found on PATH` }
  }
  return runVersionCheck(binPath, command)
}

// ── Working-directory validation (shared) ─────────────────────────────────

function resolveWorkingDirectory(value, label) {
  const raw = typeof value === "string" ? value.trim() : ""
  if (!raw) throw new Error(`${label} requires an active project working directory`)
  if (!path.isAbsolute(raw)) throw new Error(`${label} working directory must be an absolute project path`)
  let meta
  try {
    meta = fs.statSync(raw)
  } catch {
    throw new Error(`${label} working directory does not exist or cannot be read: ${raw}`)
  }
  if (!meta.isDirectory()) throw new Error(`${label} working directory is not a directory: ${raw}`)
  const indexPath = path.join(raw, "wiki", "index.md")
  let indexMeta
  try {
    indexMeta = fs.statSync(indexPath)
  } catch {
    throw new Error(`${label} working directory must be an LLM Wiki project containing wiki/index.md: ${raw}`)
  }
  if (!indexMeta.isFile()) throw new Error(`${label} working directory must be an LLM Wiki project containing wiki/index.md: ${raw}`)
  return fs.realpathSync(raw)
}

// ── Arg builders (exact port of the Rust vectors) ─────────────────────────

const ISOLATED_MCP_CONFIG = '{"mcpServers":{}}'

export function buildClaudeCliArgs(model, isolateLocalConfig) {
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--verbose",
  ]
  if (isolateLocalConfig) {
    args.push(
      "--setting-sources", "project",
      "--strict-mcp-config",
      "--mcp-config", ISOLATED_MCP_CONFIG,
      "--disable-slash-commands",
      "--tools", "",
      "--no-session-persistence",
      "--prompt-suggestions", "false",
    )
  }
  args.push("--model", model)
  return args
}

export function buildCodexCliArgs(model, isolateLocalConfig) {
  const args = ["-a", "never", "exec"]
  if (isolateLocalConfig) {
    args.push("--ignore-user-config", "--ignore-rules")
  }
  args.push(
    "--json",
    "--skip-git-repo-check",
    "--sandbox", "read-only",
    "--ephemeral",
    "--model", model,
    "-",
  )
  return args
}

const DEFAULT_CODEX_SPAWN_TIMEOUT_MINUTES = 10
const MIN_CODEX_SPAWN_TIMEOUT_MINUTES = 1
const MAX_CODEX_SPAWN_TIMEOUT_MINUTES = 240

export function codexSpawnTimeoutMinutes(value) {
  const v = value == null ? DEFAULT_CODEX_SPAWN_TIMEOUT_MINUTES : value
  return Math.min(MAX_CODEX_SPAWN_TIMEOUT_MINUTES, Math.max(MIN_CODEX_SPAWN_TIMEOUT_MINUTES, v))
}

// ── Claude content shaping ────────────────────────────────────────────────

function contentTextOnly(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("")
}

/** Map a frontend message content (string or block array) to the CLI's
 *  block-array form. Image blocks are reshaped to Anthropic's source shape. */
export function contentBlocks(content) {
  if (typeof content === "string") return [{ type: "text", text: content }]
  if (!Array.isArray(content)) return []
  const blocks = []
  for (const b of content) {
    if (!b || typeof b !== "object") continue
    if (b.type === "text" && typeof b.text === "string") {
      blocks.push({ type: "text", text: b.text })
    } else if (b.type === "image") {
      blocks.push({
        type: "image",
        source: { type: "base64", media_type: b.mediaType, data: b.dataBase64 },
      })
    }
  }
  return blocks
}

/** Fold the system preamble into the first user text block (or add a leading
 *  text block for image-only turns). Returns a new array. */
export function mergeSystemPreamble(content, preamble) {
  if (!preamble) return content
  const blocks = content.map((b) => ({ ...b }))
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].type === "text" && typeof blocks[i].text === "string") {
      blocks[i] = { type: "text", text: `${preamble}\n\n${blocks[i].text}` }
      return blocks
    }
  }
  blocks.unshift({ type: "text", text: preamble })
  return blocks
}

// ── Subprocess plumbing ───────────────────────────────────────────────────

function spawnChild(binPath, args, opts, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(binPath, args, opts)
    let settled = false
    child.once("spawn", () => { if (!settled) { settled = true; resolve(child) } })
    child.once("error", (err) => {
      if (!settled) { settled = true; reject(new Error(`Failed to spawn ${label}: ${err.message}`)) }
    })
  })
}

/** Line splitter mirroring tokio BufReader::lines(): splits on \n, strips a
 *  trailing \r, and yields any final partial line on flush (EOF). */
function makeLineEmitter(onLine) {
  let buf = ""
  return {
    push(chunk) {
      buf += chunk
      let idx
      while ((idx = buf.indexOf("\n")) >= 0) {
        let line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        if (line.endsWith("\r")) line = line.slice(0, -1)
        onLine(line)
      }
    },
    flush() {
      if (!buf) return
      const line = buf.endsWith("\r") ? buf.slice(0, -1) : buf
      buf = ""
      onLine(line)
    },
  }
}

const STDOUT_LIMIT_BYTES = 1024 * 1024
const STDERR_LIMIT_BYTES = 1024 * 1024

function appendCappedLine(state, line, limitBytes) {
  if (Buffer.byteLength(state.text, "utf8") >= limitBytes) return
  const candidate = state.text + line
  if (Buffer.byteLength(candidate, "utf8") > limitBytes) {
    // Truncate to the byte cap without appending a newline (matches Rust,
    // which only adds '\n' while still under the limit).
    state.text = Buffer.from(candidate, "utf8").subarray(0, limitBytes).toString("utf8")
  } else {
    state.text = candidate + "\n"
  }
}

// Running children keyed by frontend-generated stream id.
const claudeChildren = new Map()
const codexChildren = new Map()

// ── Claude Code CLI ───────────────────────────────────────────────────────

async function claudeCliSpawn(args) {
  const { streamId, model, messages = [], isolateLocalConfig = false, workingDirectory } = args || {}
  if (!streamId) throw new Error("claude_cli_spawn requires a streamId")

  // Fold system messages into a preamble on the first user turn (the CLI has
  // no portable system-prompt flag across versions).
  const systemPreamble = messages
    .filter((m) => m && m.role === "system")
    .map((m) => contentTextOnly(m.content))
    .join("\n\n")
  const conversation = messages.filter((m) => m && (m.role === "user" || m.role === "assistant"))
  if (conversation.length === 0) throw new Error("No user/assistant messages to send to claude CLI")

  let firstUserSeen = false
  const turns = conversation.map((m) => {
    let content = contentBlocks(m.content)
    if (!firstUserSeen && m.role === "user" && systemPreamble) {
      content = mergeSystemPreamble(content, systemPreamble)
      firstUserSeen = true
    }
    return [m.role, content]
  })

  const cwd = resolveWorkingDirectory(workingDirectory, "Claude Code CLI")
  const claude = findCliCommand("claude")
  const child = await spawnChild(claude, buildClaudeCliArgs(model, isolateLocalConfig), {
    cwd, env: spawnEnv(), stdio: ["pipe", "pipe", "pipe"],
  }, "claude")

  // stream-json input: one JSON event per line; content MUST be a block array.
  for (const [role, content] of turns) {
    child.stdin.write(JSON.stringify({ type: role, message: { role, content } }) + "\n")
  }
  child.stdin.end()

  claudeChildren.set(streamId, child)
  const topic = `claude-cli:${streamId}`
  const doneTopic = `claude-cli:${streamId}:done`

  const emitter = makeLineEmitter((line) => emit(topic, line))
  let stderrText = ""
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stdout.on("data", (d) => emitter.push(d))
  child.stderr.on("data", (d) => { stderrText += d })
  child.on("close", (code) => {
    emitter.flush()
    if (claudeChildren.get(streamId) === child) claudeChildren.delete(streamId)
    emit(doneTopic, { code: code == null ? null : code, stderr: stderrText })
  })

  return null
}

function claudeCliKill(args) {
  const { streamId } = args || {}
  const child = claudeChildren.get(streamId)
  if (child) {
    claudeChildren.delete(streamId)
    try { child.kill("SIGKILL") } catch { /* already gone */ }
  }
  return null
}

// ── Codex CLI ─────────────────────────────────────────────────────────────

async function codexCliSpawn(args) {
  const { streamId, model, prompt, isolateLocalConfig = false, timeoutMinutes, workingDirectory } = args || {}
  if (!streamId) throw new Error("codex_cli_spawn requires a streamId")
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("No prompt to send to codex CLI")

  const cwd = resolveWorkingDirectory(workingDirectory, "Codex CLI")
  const codex = findCliCommand("codex")
  const child = await spawnChild(codex, buildCodexCliArgs(model, isolateLocalConfig), {
    cwd, env: spawnEnv(), stdio: ["pipe", "pipe", "pipe"],
  }, "codex")

  child.stdin.write(prompt)
  child.stdin.end()

  const run = { child, timer: null, timedOut: false }
  codexChildren.set(streamId, run)

  const mins = codexSpawnTimeoutMinutes(timeoutMinutes)
  const topic = `codex-cli:${streamId}`
  const doneTopic = `codex-cli:${streamId}:done`
  const stdoutState = { text: "" }
  const stderrState = { text: "" }

  run.timer = setTimeout(() => {
    if (codexChildren.get(streamId) === run) {
      run.timedOut = true
      codexChildren.delete(streamId)
      try { child.kill("SIGKILL") } catch { /* already gone */ }
    }
  }, mins * 60 * 1000)
  if (run.timer && typeof run.timer.unref === "function") run.timer.unref()

  const emitter = makeLineEmitter((line) => {
    appendCappedLine(stdoutState, line, STDOUT_LIMIT_BYTES)
    emit(topic, line)
  })
  const stderrEmitter = makeLineEmitter((line) => appendCappedLine(stderrState, line, STDERR_LIMIT_BYTES))

  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stdout.on("data", (d) => emitter.push(d))
  child.stderr.on("data", (d) => stderrEmitter.push(d))
  child.on("close", (code) => {
    emitter.flush()
    stderrEmitter.flush()
    if (run.timer) clearTimeout(run.timer)
    if (codexChildren.get(streamId) === run) codexChildren.delete(streamId)

    let stderrText = stderrState.text
    if (run.timedOut) {
      if (stderrText) stderrText += "\n"
      stderrText += `Codex CLI timed out after ${mins} minutes.`
    } else if (Buffer.byteLength(stderrText, "utf8") >= STDERR_LIMIT_BYTES) {
      stderrText += "\n[stderr truncated]"
    }
    let stdoutText = stdoutState.text
    if (Buffer.byteLength(stdoutText, "utf8") >= STDOUT_LIMIT_BYTES) {
      stdoutText += "\n[stdout truncated]"
    }
    const finalCode = run.timedOut ? -1 : (code == null ? null : code)
    emit(doneTopic, { code: finalCode, stderr: stderrText, stdout: stdoutText })
  })

  return null
}

function codexCliKill(args) {
  const { streamId } = args || {}
  const run = codexChildren.get(streamId)
  if (run) {
    codexChildren.delete(streamId)
    if (run.timer) clearTimeout(run.timer)
    try { run.child.kill("SIGKILL") } catch { /* already gone */ }
  }
  return null
}

// ── Command registry ──────────────────────────────────────────────────────

export const cliCommands = {
  claude_cli_detect: () => detectCli("claude"),
  claude_cli_spawn: (a) => claudeCliSpawn(a),
  claude_cli_kill: (a) => claudeCliKill(a),
  codex_cli_detect: () => detectCli("codex"),
  codex_cli_spawn: (a) => codexCliSpawn(a),
  codex_cli_kill: (a) => codexCliKill(a),
}
