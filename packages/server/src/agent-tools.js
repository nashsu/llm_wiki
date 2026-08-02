import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { searchCommands } from "./commands/search.js"
import { webSearchCommands } from "./commands/websearch.js"
import { recordFileVersion } from "./commands/fileHistory.js"
import { searchGraph } from "./graph.js"
import { listAvailableSkills, readSkillReference } from "./skills.js"
import { isShellCommandAllowedWithoutPrompt, shellApprovalSummary } from "./shell-policy.js"

// Agent tool specs + executors (Node port of the desktop agent's tool set in
// src-tauri/src/agent/tools.rs). Each executor returns
// { observation, references?, fileChanges? }. The runtime emits the matching
// SSE events (toolStart/toolEnd/referenceAdded/fileChanged) the UI expects.

const fwd = (p) => p.split(path.sep).join("/")
const clip = (s, n = 4000) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n) + "\n…[truncated]" : s }

function rel(projectPath, p) { return fwd(path.relative(projectPath, p)) }

const STOP = new Set(["the","is","a","an","of","to","in","on","for","and","or","with","by","as","it","be","are","was","were"])
function tokens(q) {
  return [...new Set((q || "").toLowerCase().split(/[\s,。.!?;:()""''\-_/]+/).filter((t) => t.length > 1 && !STOP.has(t)))]
}

function walk(dir, out, pred) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full, out, pred)
    else if (pred(e, full)) out.push(full)
  }
}

const SPECS = {
  "wiki.search": { description: "Search the generated wiki pages by keyword. Returns matching pages with snippets.", parameters: { type: "object", properties: { query: { type: "string" }, top_k: { type: "integer" } }, required: ["query"] } },
  "wiki.read_page": { description: "Read the full content of a wiki page by project-relative path (e.g. wiki/concepts/foo.md).", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  "source.search": { description: "Search the imported raw source documents (raw/sources) by keyword.", parameters: { type: "object", properties: { query: { type: "string" }, top_k: { type: "integer" } }, required: ["query"] } },
  "graph.search": { description: "Search the knowledge graph for pages related to a query.", parameters: { type: "object", properties: { query: { type: "string" }, top_k: { type: "integer" } }, required: ["query"] } },
  "web.search": { description: "Search the public web using the configured provider.", parameters: { type: "object", properties: { query: { type: "string" }, max_results: { type: "integer" } }, required: ["query"] } },
  "anytxt.search": { description: "Search local indexed documents via AnyTXT (if configured).", parameters: { type: "object", properties: { query: { type: "string" }, max_results: { type: "integer" } }, required: ["query"] } },
  "wiki.write_page": { description: "Create or overwrite a wiki page. path is project-relative under wiki/.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  "workspace.write_file": { description: "Write a generated output file under agent-workspace/.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  "workspace.append_file": { description: "Append text to a generated output file under agent-workspace/.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  "shell.exec": { description: "Run a shell command on the server host (gated; requires approval/enablement).", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  "skills.load": { description: "List available agent skills.", parameters: { type: "object", properties: {} } },
  "skill.read_file": { description: "Read a skill's instruction file by id/path.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  "llm.generate": { description: "Run a one-shot LLM generation with a prompt (no tools).", parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] } },
  "deep_research.run": { description: "Collect broader external/local evidence for deep research turns before synthesis.", parameters: { type: "object", properties: { query: { type: "string" }, sources: { type: "array", items: { enum: ["web", "anytxt", "wiki", "source"] } } }, required: ["query"] } },
}

function specList(names) {
  return names.map((n) => ({ name: n, description: SPECS[n].description, parameters: SPECS[n].parameters }))
}

async function wikiSearch(input, ctx) {
  const topK = input.top_k ?? ctx.topK ?? 5
  const res = await searchCommands.search_project({ projectPath: ctx.projectPath, query: input.query, topK, includeContent: ctx.includeContent })
  const references = res.results.map((r) => ({ title: r.title, path: r.path, kind: "wiki", snippet: r.snippet, score: r.score }))
  const observation = res.results.length
    ? res.results.map((r) => `- ${r.title} (${r.path}): ${r.snippet}`).join("\n")
    : "No wiki pages matched the query."
  return { observation, references }
}

async function wikiReadPage(input, ctx) {
  const p = path.isAbsolute(input.path) ? input.path : path.join(ctx.projectPath, input.path.replace(/^\/+/, ""))
  if (!p.startsWith(path.join(ctx.projectPath, "wiki"))) throw new Error("wiki.read_page path must be under wiki/")
  const content = await fsp.readFile(p, "utf-8")
  return { observation: clip(content, 12000) }
}

async function sourceSearch(input, ctx) {
  const dir = path.join(ctx.projectPath, "raw", "sources")
  const files = []
  walk(dir, files, (e) => /\.(md|txt|text|org|html?|csv|json|xml|rst)$/i.test(e.name))
  const toks = tokens(input.query)
  const scored = []
  for (const f of files) {
    let content
    try { content = await fsp.readFile(f, "utf-8") } catch { continue }
    const lower = content.toLowerCase()
    const score = toks.reduce((s, t) => s + (lower.includes(t) ? 1 : 0), 0)
    if (score > 0) {
      const idx = lower.indexOf(toks[0])
      const snippet = clip(content.slice(Math.max(0, idx - 40), idx + 160).replace(/\s+/g, " "), 200)
      scored.push({ score, ref: { title: path.basename(f), path: rel(ctx.projectPath, f), kind: "source", snippet } })
    }
  }
  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, input.top_k ?? ctx.topK ?? 5)
  return { observation: top.length ? top.map((s) => `- ${s.ref.path}: ${s.ref.snippet}`).join("\n") : "No source documents matched.", references: top.map((s) => s.ref) }
}

async function graphSearch(input, ctx) {
  const topK = input.top_k ?? ctx.topK ?? 5
  const refs = searchGraph(ctx.projectPath, input.query, topK)
  const observation = refs.length
    ? refs.map((r) => `- ${r.title} (${r.path}): ${r.snippet}`).join("\n")
    : "No graph results for the query."
  const references = refs.map((r) => ({
    title: r.title, path: r.path, kind: "graph", snippet: r.snippet, score: r.score,
    knowledgeContext: r.knowledgeContext,
  }))
  return { observation, references }
}

async function webSearch(input, ctx) {
  const config = ctx.store.searchApiConfig ?? ctx.store.searchConfig ?? {}
  const results = await webSearchCommands.web_search({ query: input.query, config, maxResults: input.max_results ?? 5 })
  const references = results.map((r) => ({ title: r.title, path: r.url, kind: "web", snippet: r.snippet, url: r.url }))
  return { observation: results.length ? results.map((r) => `- ${r.title}: ${r.snippet} (${r.url})`).join("\n") : "No web results.", references }
}

async function anytxtSearch(input, ctx) {
  const config = ctx.store.anytxtConfig ?? {}
  const results = await webSearchCommands.anytxt_search({ query: input.query, config, maxResults: input.max_results ?? 5 })
  const references = results.map((r) => ({ title: r.title, path: r.url, kind: "anytxt", snippet: r.snippet }))
  return { observation: results.length ? results.map((r) => `- ${r.title}: ${r.snippet}`).join("\n") : "No AnyTXT results.", references }
}

async function writeUnder(projectPath, relPath, content, mode, toolName) {
  const target = path.join(projectPath, relPath.replace(/^\/+/, ""))
  if (!target.startsWith(projectPath + path.sep) && target !== projectPath) throw new Error("Write target escapes the project")
  const existedBefore = fs.existsSync(target)
  const previousContent = existedBefore ? await fsp.readFile(target, "utf-8").catch(() => null) : null
  await fsp.mkdir(path.dirname(target), { recursive: true })
  if (mode === "append" && existedBefore) await fsp.appendFile(target, content, "utf-8")
  else { recordFileVersion(target, "baseline", `before.agent.${toolName}`); await fsp.writeFile(target, content, "utf-8") }
  recordFileVersion(target, "agent", `agent.${toolName}`)
  return { existedBefore, previousContent, target }
}

async function wikiWritePage(input, ctx) {
  let relPath = input.path.replace(/^\/+/, "")
  if (!relPath.startsWith("wiki/")) relPath = `wiki/${relPath}`
  const { existedBefore, previousContent, target } = await writeUnder(ctx.projectPath, relPath, input.content, "write", "wiki_write")
  return {
    observation: `Wrote wiki page ${rel(ctx.projectPath, target)} (${input.content.length} chars).`,
    fileChanges: [{ path: rel(ctx.projectPath, target), tool: "wiki.write_page", existedBefore, previousContent }],
  }
}

async function workspaceWrite(input, ctx, append) {
  let relPath = input.path.replace(/^\/+/, "")
  if (!relPath.startsWith("agent-workspace/")) relPath = `agent-workspace/${relPath}`
  const { existedBefore, previousContent, target } = await writeUnder(ctx.projectPath, relPath, input.content, append ? "append" : "write", append ? "workspace_append" : "workspace_write")
  const rpath = rel(ctx.projectPath, target)
  return {
    observation: `${append ? "Appended to" : "Wrote"} ${rpath}.`,
    references: [{ title: path.basename(target), path: rpath, kind: "workspace", snippet: "" }],
    fileChanges: [{ path: rpath, tool: append ? "workspace.append_file" : "workspace.write_file", existedBefore, previousContent }],
  }
}

async function shellExec(input, ctx) {
  // Runs an ALLOWED shell command on the server host. The agent loop (agent.js)
  // performs the desktop's full pre-check before reaching here (skills gate,
  // preference-probe skip, and the per-command approval policy in
  // shell-policy.js — a 1:1 port of runtime.rs). This defensive gate guarantees
  // a command is never executed unless it is approved or workspace-scoped, even
  // if shell.exec is ever invoked outside the loop.
  const command = String(input?.command ?? input?.query ?? "").trim()
  if (!command) throw new Error("shell.exec requires command")
  const envAllowed = process.env.LLM_WIKI_ALLOW_SHELL === "1"
  if (!envAllowed && !isShellCommandAllowedWithoutPrompt(command, ctx?.approvedShellCommands, ctx?.projectPath)) {
    return { observation: `approval required: ${command}`, approvalRequired: true, approvalSummary: shellApprovalSummary(command) }
  }
  const { spawn } = await import("node:child_process")
  const out = await new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], { timeout: 30000 })
    let buf = ""
    child.stdout?.on("data", (d) => { buf += d.toString() })
    child.stderr?.on("data", (d) => { buf += d.toString() })
    child.on("close", (code) => resolve(`exit ${code}\n${buf.slice(0, 8000)}`))
    child.on("error", (e) => resolve(`failed: ${e.message}`))
  })
  return { observation: clip(out) }
}


async function skillsLoad(_input, ctx) {
  const avail = listAvailableSkills(ctx.projectPath)
  if (!avail.length) return { observation: "No agent skills are available." }
  const observation = avail.map((s) => `- ${s.id} (${s.source}): ${s.description}`).join("\n")
  return { observation }
}
async function skillReadFile(input, ctx) {
  const content = readSkillReference(ctx.projectPath, ctx.skills ?? [], input.path)
  return { observation: clip(content, 32000) }
}

async function llmGenerate(input, ctx) {
  const { blockingCall } = await import("./llm-call.js")
  const { normalizeEndpoint } = await import("./llm-resolve.js")
  const ep = normalizeEndpoint(ctx.llmConfig)
  const r = await blockingCall({ ...ep, messages: [{ role: "user", content: input.prompt }], signal: ctx.signal })
  return { observation: clip(r.content, 8000) }
}

async function deepResearch(input, _ctx) {
  // Registry-level executor (mirrors tools.rs): deep_research.run is
  // orchestrated by the agent runtime itself, so a direct registry call
  // simply returns the coordination marker. The loop executor never reaches
  // this — it rejects the tool beforehand (see LOOP_TOOL_REJECTIONS).
  const query = typeof input.query === "string" ? input.query.trim() : ""
  if (!query) throw new Error("deep_research.run requires query")
  return { observation: JSON.stringify({ query, status: "orchestrated_by_agent_runtime" }) }
}

// Tools the loop executor refuses to run, mirroring the desktop's per-tool
// permission gate (runtime.rs execute_agent_loop_tool). deep_research.run is
// runtime-orchestrated: the runtime emits its start/end events around the
// retrieval phase; the model must use the concrete search tools directly.
export const LOOP_TOOL_REJECTIONS = {
  "deep_research.run": "deep_research.run is not available in the loop executor; use web.search, anytxt.search, source.search, and wiki.search directly",
}

const EXEC = {
  "wiki.search": wikiSearch, "wiki.read_page": wikiReadPage, "source.search": sourceSearch,
  "graph.search": graphSearch, "web.search": webSearch, "anytxt.search": anytxtSearch,
  "wiki.write_page": wikiWritePage,
  "workspace.write_file": (i, c) => workspaceWrite(i, c, false),
  "workspace.append_file": (i, c) => workspaceWrite(i, c, true),
  "shell.exec": shellExec, "skills.load": skillsLoad, "skill.read_file": skillReadFile,
  "llm.generate": llmGenerate, "deep_research.run": deepResearch,
}

/** Decide which tools to expose for a request, mirroring the desktop gating. */
export function toolsForRequest(request, mode) {
  const names = ["wiki.search", "wiki.read_page", "source.search", "graph.search"]
  if (request.tools?.web) names.push("web.search")
  if (request.tools?.anytxt) names.push("anytxt.search")
  if (mode !== "fast") names.push("wiki.write_page", "workspace.write_file", "workspace.append_file", "shell.exec")
  names.push("skills.load", "skill.read_file", "llm.generate")
  // NOTE: deep_research.run is deliberately NOT offered to the model. Like
  // the desktop runtime, it is orchestrated by the runtime itself (see
  // agent.js) and the loop executor rejects model-issued calls for it.
  return names
}

export function buildToolSpecs(names) { return specList(names) }
export async function runTool(name, input, ctx) {
  const fn = EXEC[name]
  if (!fn) throw new Error(`Unknown Agent tool: ${name}`)
  return await fn(input ?? {}, ctx)
}
