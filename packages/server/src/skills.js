import fs from "node:fs"
import path from "node:path"
import os from "node:os"

// Server port of src-tauri/src/agent/skills.rs: scan SKILL.md folders, load
// requested skills, and render the planner-context block the model sees. The
// scan roots are identical to the desktop (project `.llm-wiki/skills` plus the
// user's `~/.claude|~/.codex|~/.agents/skills`), so the web client's Settings
// → Skills tab and the agent's injected instructions match the desktop
// exactly for the same on-disk skills (shared user data).

const MAX_SKILL_FILE_BYTES = 64000
const MAX_SKILL_SCAN_DEPTH = 8
const MAX_SKILL_REFERENCE_BYTES = 256 * 1024

const fwd = (p) => p.split(path.sep).join("/")

const RESERVED = new Set([
  "CON","PRN","AUX","NUL",
  ...Array.from({length:9},(_,i)=>`COM${i+1}`),
  ...Array.from({length:9},(_,i)=>`LPT${i+1}`),
])

function isPortableSkillName(value) {
  if (value.endsWith(" ") || value.endsWith(".")) return false
  for (const ch of value) {
    const c = ch.codePointAt(0)
    if ("<>:\"|?*".includes(ch) || c <= 0x1f) return false
  }
  const stem = (value.split(".")[0] ?? value).replace(/ +$/,"").toUpperCase()
  return !RESERVED.has(stem)
}

export function normalizeSkillName(value) {
  const t = String(value ?? "").trim()
  if (!t || t.includes("/") || t.includes("\\") || t.includes("..")) return null
  if (!isPortableSkillName(t)) return null
  return t
}

function splitFrontmatter(raw) {
  let s = String(raw)
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1)
  s = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  if (!s.startsWith("---\n")) return [null, s]
  const rest = s.slice(4)
  const end = rest.indexOf("\n---")
  if (end < 0) return [null, s]
  const fm = rest.slice(0, end)
  let after = rest.slice(end + "\n---".length)
  if (after.startsWith("\n")) after = after.slice(1)
  return [fm, after]
}

function yamlStringField(fm, key) {
  const prefix = `${key}:`
  for (const line of fm.split("\n")) {
    const t = line.trim()
    if (!t.startsWith(prefix)) continue
    let v = t.slice(prefix.length).trim()
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
    else if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1)
    if (v) return v
  }
  return null
}

function isSymlink(p) { try { return fs.lstatSync(p).isSymbolicLink() } catch { return false } }

function loadSkillFile(filePath, fallbackName) {
  let st
  try { st = fs.lstatSync(filePath) } catch { throw new Error("Skill not found") }
  if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_SKILL_FILE_BYTES) {
    throw new Error("Skill file is not readable or is too large")
  }
  const raw = fs.readFileSync(filePath, "utf-8")
  const [fm, after] = splitFrontmatter(raw)
  const name = (fm && yamlStringField(fm, "name")) || fallbackName
  const description = (fm && yamlStringField(fm, "description")) || ""
  if (!description.trim()) throw new Error("Skill description is required")
  const instructions = after.trim()
  if (!instructions) throw new Error("Skill instructions are empty")
  return {
    name, description, instructions,
    baseDir: fwd(path.dirname(filePath)),
    location: fwd(filePath),
  }
}

function findSkillMainFile(dir) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return null }
  const hit = entries.find((e) => e.name.toLowerCase() === "skill.md")
  return hit ? path.join(dir, hit.name) : null
}

function loadSkillDirectory(dir, fallbackName) {
  let st
  try { st = fs.lstatSync(dir) } catch { throw new Error("Skill folder not found") }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("Skill folder is not readable")
  const main = findSkillMainFile(dir) || path.join(dir, "SKILL.md")
  return loadSkillFile(main, fallbackName)
}

function loadSkillPath(p, fallbackName) {
  if (path.basename(p).toLowerCase() === "skill.md") {
    const parent = path.dirname(p)
    if (!parent) throw new Error("Skill file has no parent directory")
    return loadSkillDirectory(parent, fallbackName)
  }
  return loadSkillFile(p, fallbackName)
}

function isHiddenOrUnsafeSkillDir(p) {
  const name = path.basename(p)
  return name.startsWith(".") || name === "node_modules" || normalizeSkillName(name) == null
}

function discoverCandidates(root) {
  const out = []
  const walk = (dir, depth) => {
    if (depth > MAX_SKILL_SCAN_DEPTH) return
    let st
    try { st = fs.lstatSync(dir) } catch { return }
    if (st.isSymbolicLink() || !st.isDirectory()) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    entries.sort((a, b) => (path.join(dir, a.name) < path.join(dir, b.name) ? -1 : 1))
    for (const e of entries) {
      const full = path.join(dir, e.name)
      let m
      try { m = fs.lstatSync(full) } catch { continue }
      if (m.isSymbolicLink()) continue
      if (m.isFile()) {
        if (e.name.toLowerCase() === "skill.md") {
          const id = normalizeSkillName(path.basename(dir))
          if (id) out.push({ id, path: full })
          continue
        }
        if (path.extname(e.name).toLowerCase() === ".md") {
          const id = normalizeSkillName(path.basename(e.name, ".md"))
          if (id) out.push({ id, path: full })
        }
        continue
      }
      if (m.isDirectory()) {
        if (isHiddenOrUnsafeSkillDir(full)) continue
        walk(full, depth + 1)
      }
    }
  }
  walk(root, 0)
  return out
}

export function skillRoots(projectPath) {
  const roots = [{ path: path.join(projectPath, ".llm-wiki", "skills"), source: "project" }]
  const home = os.homedir()
  if (home) {
    roots.push({ path: path.join(home, ".claude", "skills"), source: "claude" })
    roots.push({ path: path.join(home, ".codex", "skills"), source: "codex" })
    roots.push({ path: path.join(home, ".agents", "skills"), source: "agents" })
  }
  return roots
}

function loadOneSkill(root, name) {
  const single = path.join(root, `${name}.md`)
  try { return loadSkillFile(single, name) } catch { /* try dir */ }
  try { return loadSkillDirectory(path.join(root, name), name) } catch { /* try discover */ }
  const cand = discoverCandidates(root).find((c) => c.id === name)
  if (!cand) return null
  try { return loadSkillPath(cand.path, name) } catch { return null }
}

export function listAvailableSkills(projectPath) {
  const map = new Map()
  for (const root of skillRoots(projectPath)) {
    for (const cand of discoverCandidates(root.path)) {
      if (map.has(cand.id)) continue
      let skill
      try { skill = loadSkillPath(cand.path, cand.id) } catch { continue }
      map.set(cand.id, { id: cand.id, name: skill.name, description: skill.description, source: root.source })
    }
  }
  return [...map.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export function loadProjectSkills(projectPath, requested) {
  if (!Array.isArray(requested) || requested.length === 0) return []
  const roots = skillRoots(projectPath)
  const names = [...new Set(requested.map(normalizeSkillName).filter(Boolean))].sort()
  const out = []
  for (const name of names) {
    for (const root of roots) {
      const skill = loadOneSkill(root.path, name)
      if (skill) { out.push(skill); break }
    }
  }
  return out
}

// ── planner-context rendering (mirrors render_skill_planner_context) ──────
function escapeXml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;")
}
function trimChars(s, n) { const a = [...String(s)]; return a.length > n ? a.slice(0, n).join("") : String(s) }

export function renderSkillPlannerContext(skills, skillMode) {
  if (!skills || skills.length === 0) return "None"
  let out = ""
  if ((skillMode || "auto") === "explicit") {
    out += "The following skills were explicitly selected by the user for this turn.\n"
    for (const skill of skills.slice(0, 8)) {
      const baseDir = escapeXml(skill.baseDir)
      const instructions = escapeXml(trimChars(skill.instructions.trim(), 1200))
      out += `<skill name="${escapeXml(skill.name)}" location="${escapeXml(skill.location)}">\nReferences are relative to ${baseDir}.\n\n${instructions}\n</skill>\n`
    }
  } else {
    out += "The following enabled skills are optional. Use them only if they match the request. Inspect a SKILL.md location only after deciding the skill is relevant.\n"
    out += "<available_skills>\n"
    for (const skill of skills.slice(0, 12)) {
      out += "  <skill>\n"
      out += `    <name>${escapeXml(skill.name)}</name>\n`
      out += `    <description>${escapeXml(skill.description.trim())}</description>\n`
      out += `    <location>${escapeXml(skill.location)}</location>\n`
      out += "  </skill>\n"
    }
    out += "</available_skills>\n"
  }
  return trimChars(out, 8000)
}

// ── skill.read_file reference resolution (mirrors runtime reference read) ─
// Accepts either an absolute path, or a "<skillname>/<rel>" prefix that maps
// onto that skill's base_dir, or a path relative to the project. Rejects
// symlinks and files larger than MAX_SKILL_REFERENCE_BYTES, and refuses to
// escape a skill's base_dir when a skill prefix was used.
export function readSkillReference(projectPath, skills, refPath) {
  const raw = String(refPath || "").trim()
  if (!raw) throw new Error("skill.read_file: path is required")
  let target = null
  // prefix form: skillname/relative
  const slash = raw.indexOf("/")
  if (slash > 0) {
    const prefix = raw.slice(0, slash)
    const rest = raw.slice(slash + 1)
    const skill = skills.find((s) => s.name.toLowerCase() === prefix.toLowerCase()
      || path.basename(s.baseDir).toLowerCase() === prefix.toLowerCase())
    if (skill) {
      const base = path.resolve(skill.baseDir)
      const cand = path.resolve(base, rest)
      if (cand === base || cand.startsWith(base + path.sep)) target = cand
    }
  }
  if (!target) {
    target = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(projectPath, raw)
  }
  let st
  try { st = fs.lstatSync(target) } catch (e) { throw new Error(`skill.read_file: ${e.message}`) }
  if (st.isSymbolicLink()) throw new Error("skill.read_file: symlinks are not allowed")
  if (!st.isFile()) throw new Error("skill.read_file: not a file")
  if (st.size > MAX_SKILL_REFERENCE_BYTES) throw new Error("skill.read_file: file too large")
  return fs.readFileSync(target, "utf-8")
}

export { MAX_SKILL_REFERENCE_BYTES }
