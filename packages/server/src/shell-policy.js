import path from "node:path"

// Faithful Node port of the desktop Agent's shell-command approval policy
// (src-tauri/src/agent/runtime.rs + workspace.rs). The desktop decides, per
// command, whether a `shell.exec` call may run immediately, needs the user's
// approval, or is rejected — purely from the command text, the per-turn
// approved list, and the project path. These functions are pure string/path
// logic so they are ported 1:1 (same predicates, same order) and unit-checked
// against the desktop's own Rust test fixtures in verify-shell-approval.mjs.

export const AGENT_WORKSPACE_DIR = "agent-workspace"

// Marker the loop uses to detect that a turn must stop at an approval boundary
// (runtime.rs: SHELL_APPROVAL_REQUIRED_OBSERVATION).
export const SHELL_APPROVAL_REQUIRED_OBSERVATION = "shell.exec.approval_required"

// runtime.rs: agent_workspace_display(project_path)
export function agentWorkspaceDisplay(projectPath) {
  return path.join(String(projectPath ?? ""), AGENT_WORKSPACE_DIR).replace(/\\/g, "/")
}

// runtime.rs: is_shell_command_approved(command, approved)
export function isShellCommandApproved(command, approved) {
  const cmd = String(command ?? "").trim()
  if (!cmd) return false
  return Array.isArray(approved) && approved.some((item) => String(item).trim() === cmd)
}

// runtime.rs: is_shell_absolute_path(value)
export function isShellAbsolutePath(value) {
  const v = String(value ?? "")
  return v.startsWith("/") || v.startsWith("\\\\") || v.charCodeAt(1) === 58 /* ':' drive letter */
}

// runtime.rs: normalize_shell_path_for_compare(value)
export function normalizeShellPathForCompare(value) {
  return String(value ?? "")
    .replace(/^["']+|["']+$/g, "")   // trim_matches('"', '\'')
    .replace(/\\/g, "/")             // replace('\\', "/")  (all)
    .replace(/\/+$/g, "")            // trim_end_matches('/')
    .toLowerCase()                   // to_ascii_lowercase()
}

// runtime.rs: shell_command_tokens(command) — split on whitespace and the
// shell metacharacters ;|&()<>, honoring single/double quotes (quote chars are
// dropped; their contents are kept literally, spaces included). No escapes.
export function shellCommandTokens(command) {
  const tokens = []
  let current = ""
  let quote = null
  for (const ch of String(command ?? "")) {
    if (quote !== null) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; continue }
    if (/\s/.test(ch) || ";|&()<>".includes(ch)) {
      if (current) { tokens.push(current); current = "" }
      continue
    }
    current += ch
  }
  if (current) tokens.push(current)
  return tokens
}

// runtime.rs: shell_token_mentions_external_location(token, workspace_norm, project_norm)
export function shellTokenMentionsExternalLocation(token, workspaceNorm, projectNorm) {
  const t = String(token ?? "").replace(/^["',;]+|["',;]+$/g, "") // trim_matches('"','\'',',',';')
  if (!t) return false
  const lower = t.toLowerCase()
  if (
    lower.startsWith("~")
    || lower.includes("$home")
    || lower.includes("${home")
    || lower.includes("%userprofile%")
    || lower.includes("%homepath%")
    || lower.includes("$xdg_")
    || lower.includes("${xdg_")
    || lower.includes("$tmp")
    || lower.includes("${tmp")
    || lower.includes("$temp")
    || lower.includes("${temp")
  ) {
    return true
  }
  if (t === ".." || t.startsWith("../") || t.includes("/../") || t.endsWith("/..")) {
    return true
  }
  const candidates = [t]
  const eq = t.indexOf("=")
  if (eq !== -1) candidates.push(t.slice(eq + 1)) // split_once('=') -> value after first '='
  for (let candidate of candidates) {
    candidate = candidate.replace(/^["']+|["']+$/g, "") // trim_matches('"','\'')
    if (!candidate) continue
    if (isShellAbsolutePath(candidate)) {
      const normalized = normalizeShellPathForCompare(candidate)
      const inWorkspace = normalized === workspaceNorm || normalized.startsWith(`${workspaceNorm}/`)
      const projectWorkspacePrefix = `${projectNorm}/${AGENT_WORKSPACE_DIR}`
      const inProjectWorkspace = normalized === projectWorkspacePrefix
        || normalized.startsWith(`${projectWorkspacePrefix}/`)
      if (!inWorkspace && !inProjectWorkspace) return true
    }
  }
  return false
}

// runtime.rs: is_shell_command_scoped_to_agent_workspace(command, project_path)
export function isShellCommandScopedToAgentWorkspace(command, projectPath) {
  const cmd = String(command ?? "").trim()
  if (!cmd) return false
  const lower = cmd.toLowerCase()
  if (
    lower.includes("http://")
    || lower.includes("https://")
    || lower.includes("ftp://")
    || lower.includes("sftp://")
    || lower.includes("curl ")
    || lower.startsWith("curl ")
    || lower.includes("wget ")
    || lower.startsWith("wget ")
    || lower.includes("scp ")
    || lower.startsWith("scp ")
    || lower.includes("ssh ")
    || lower.startsWith("ssh ")
    || lower.includes("$(")
    || cmd.includes("`")
  ) {
    return false
  }
  const workspace = agentWorkspaceDisplay(projectPath)
  const workspaceNorm = normalizeShellPathForCompare(workspace)
  const projectNorm = normalizeShellPathForCompare(projectPath)
  for (const token of shellCommandTokens(cmd)) {
    if (!token) continue
    if (shellTokenMentionsExternalLocation(token, workspaceNorm, projectNorm)) return false
  }
  return true
}

// runtime.rs: is_shell_command_allowed_without_prompt(command, approved, project_path)
export function isShellCommandAllowedWithoutPrompt(command, approved, projectPath) {
  return isShellCommandApproved(command, approved)
    || isShellCommandScopedToAgentWorkspace(command, projectPath)
}

// runtime.rs: is_skill_preference_probe_command(command)
export function isSkillPreferenceProbeCommand(command) {
  const lower = String(command ?? "").toLowerCase()
  return (lower.includes("extend.md") || lower.includes("baoyu-skills"))
    && (lower.includes("test -f") || lower.includes("test-path"))
}

// runtime.rs: skipped_skill_preference_probe_summary(command)
export function skippedSkillPreferenceProbeSummary(command) {
  return `Skipped optional skill preference probe instead of running shell command:\n\`${command}\`\nNo EXTEND.md preferences were loaded. Continue with the selected skill using its defaults, and do not retry this probe.`
}

// runtime.rs: the approval observation summary shown in the assistant bubble
// (and emitted as the final messageDelta) when a command needs approval.
export function shellApprovalSummary(command) {
  return `The Agent needs approval before it can run this command:\n\n\`${command}\`\n\nApprove the command if you want the Agent to continue with this skill.`
}

// runtime.rs: the skills-gate rejection message for shell.exec.
export const SHELL_REQUIRES_SKILL_ERROR =
  "shell.exec is only available when at least one skill is active for this turn"
