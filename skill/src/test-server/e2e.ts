/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * End-to-end test harness — runs every CLI command and every MCP tool against
 * a real on-disk wiki fixture and a real local OpenAI/Tavily-compatible HTTP
 * server. No code-level mocks. All paths exercise real fetch / SSE parsing /
 * file I/O.
 *
 * Output: a markdown report at skill/docs/test-report.md plus stdout.
 */
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { spawn } from "child_process"
import { startFakeServer, type FakeServerHandle } from "../test-server/fake-llm-server"

const SKILL_ROOT = path.resolve(__dirname, "../..")
const CLI = path.join(SKILL_ROOT, "dist", "cli.js")
const MCP = path.join(SKILL_ROOT, "dist", "mcp-server.js")

interface CaseResult {
  name: string
  command: string
  exitCode: number | null
  stdout: string
  stderr: string
  ok: boolean
  notes?: string
}

const results: CaseResult[] = []

function runCli(name: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<CaseResult> {
  process.stderr.write(`[e2e] running: ${name}\n`)
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
    })
    let stdout = ""
    let stderr = ""
    proc.stdout.on("data", (d) => { stdout += d.toString() })
    proc.stderr.on("data", (d) => { stderr += d.toString() })
    const timer = setTimeout(() => { proc.kill("SIGKILL") }, 60_000)
    proc.on("close", (code) => {
      clearTimeout(timer)
      const r: CaseResult = {
        name,
        command: `node dist/cli.js ${args.join(" ")}`,
        exitCode: code,
        stdout,
        stderr,
        ok: code === 0,
      }
      process.stderr.write(`[e2e]   exit=${code} stdout=${stdout.length}B stderr=${stderr.length}B\n`)
      results.push(r)
      resolve(r)
    })
  })
}

// ── Build the wiki fixture ──────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "llm-wiki-e2e-"))
const PROJECT = path.join(TMP, "project")
const RAW = path.join(TMP, "raw")
fs.mkdirSync(PROJECT, { recursive: true })
fs.mkdirSync(RAW, { recursive: true })

console.log(`[e2e] fixture root: ${TMP}`)

// Use init to scaffold (call moved into main() so we can await)
async function scaffoldFixture(): Promise<void> {
  await runCli("init", ["init", PROJECT])
}

// Drop a small but realistic seed wiki: a few interlinked pages
const seed: Record<string, string> = {
  "wiki/concepts/transformer.md": [
    "---",
    "type: concept",
    "title: Transformer",
    "created: 2026-04-01",
    "updated: 2026-04-01",
    "tags: [ml, architecture]",
    "related: [attention-mechanism, bert]",
    'sources: ["intro.md"]',
    "---",
    "",
    "# Transformer",
    "",
    "The Transformer is a neural network architecture based on the [[attention-mechanism]].",
    "It powers models like [[bert]] and modern large language models.",
    "",
  ].join("\n"),
  "wiki/concepts/attention-mechanism.md": [
    "---",
    "type: concept",
    "title: Attention Mechanism",
    "created: 2026-04-01",
    "updated: 2026-04-01",
    "tags: [ml]",
    "related: [transformer]",
    'sources: ["intro.md"]',
    "---",
    "",
    "# Attention Mechanism",
    "",
    "Attention lets a model focus on relevant parts of its input.",
    "It is the core innovation behind the [[transformer]].",
    "",
  ].join("\n"),
  "wiki/entities/bert.md": [
    "---",
    "type: entity",
    "title: BERT",
    "created: 2026-04-02",
    "updated: 2026-04-02",
    "tags: [ml, model]",
    "related: [transformer]",
    'sources: ["bert-paper.md"]',
    "---",
    "",
    "# BERT",
    "",
    "BERT is a [[transformer]]-based language model from Google (2018).",
    "",
  ].join("\n"),
  "wiki/entities/orphan-thing.md": [
    "---",
    "type: entity",
    "title: Orphan Thing",
    "created: 2026-04-03",
    "updated: 2026-04-03",
    "tags: []",
    "related: []",
    'sources: ["misc.md"]',
    "---",
    "",
    "# Orphan Thing",
    "",
    "An entity with no inbound or outbound links — should trip the lint check.",
    "",
  ].join("\n"),
  "wiki/sources/intro.md": [
    "---",
    "type: source",
    'title: "Source: intro.md"',
    "created: 2026-04-01",
    "updated: 2026-04-01",
    'sources: ["intro.md"]',
    "tags: []",
    "related: [transformer, attention-mechanism]",
    "---",
    "",
    "# Source: intro.md",
    "",
    "Introduces [[transformer]] and [[attention-mechanism]].",
    "",
  ].join("\n"),
  "wiki/index.md": [
    "---",
    "title: Index",
    "type: overview",
    "---",
    "",
    "# Knowledge Base",
    "",
    "## Concepts",
    "- [[transformer]]",
    "- [[attention-mechanism]]",
    "",
    "## Entities",
    "- [[bert]]",
    "",
  ].join("\n"),
}
for (const [rel, content] of Object.entries(seed)) {
  const p = path.join(PROJECT, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}

// Drop a raw source for ingest
const RAW_SOURCE = path.join(RAW, "rnn-vs-transformer.md")
fs.writeFileSync(RAW_SOURCE, [
  "# RNNs vs Transformers",
  "",
  "Recurrent Neural Networks (RNNs) process sequences token-by-token, while the",
  "Transformer architecture relies on self-attention and processes the whole",
  "sequence in parallel. Models like BERT and GPT are based on Transformers.",
  "Mamba is a recent state-space model that revisits some RNN ideas.",
  "",
].join("\n"))

// ── Phase 1: non-LLM commands ───────────────────────────────────────────────
async function runNonLLMPhase(): Promise<void> {
  await runCli("status", ["status", PROJECT])
  await runCli("search", ["search", PROJECT, "attention"])
  await runCli("graph", ["graph", PROJECT])
  await runCli("insights", ["insights", PROJECT])
  await runCli("lint", ["lint", PROJECT])
}

// ── Phase 2: ingest with the local fake LLM server ──────────────────────────
async function withFakeServer<T>(fn: (h: FakeServerHandle) => Promise<T>): Promise<T> {
  const handle = await startFakeServer(0)
  try { return await fn(handle) } finally { await handle.close() }
}

function ingestStage1Reply(): string[] {
  return [
    "## Key Entities\n",
    "- **Mamba** (model)\n",
    "- **GPT** (model)\n\n",
    "## Key Concepts\n",
    "- **Recurrent Neural Network (RNN)**: sequential processing.\n",
    "- **Self-attention**: parallel sequence modeling.\n\n",
    "## Recommendations\n",
    "- Create concept page for RNN.\n",
    "- Create entity page for Mamba.\n",
  ]
}

function ingestStage2Reply(sourceFile: string): string[] {
  // Build one big string then chunk it; easier than threading chunks
  const today = new Date().toISOString().slice(0, 10)
  const text = [
    `---FILE: wiki/sources/${sourceFile.replace(/\.[^.]+$/, "")}.md---`,
    "---",
    "type: source",
    `title: "Source: ${sourceFile}"`,
    `created: ${today}`,
    `updated: ${today}`,
    `sources: ["${sourceFile}"]`,
    "tags: [ml]",
    "related: [transformer, recurrent-neural-network, mamba]",
    "---",
    "",
    `# Source: ${sourceFile}`,
    "",
    "Compares [[recurrent-neural-network]] and [[transformer]] approaches.",
    "Notes [[mamba]] as a hybrid state-space model.",
    "---END FILE---",
    "",
    "---FILE: wiki/concepts/recurrent-neural-network.md---",
    "---",
    "type: concept",
    "title: Recurrent Neural Network",
    `created: ${today}`,
    `updated: ${today}`,
    "tags: [ml, architecture]",
    "related: [transformer]",
    `sources: ["${sourceFile}"]`,
    "---",
    "",
    "# Recurrent Neural Network",
    "",
    "RNNs process sequences token-by-token. Largely superseded by the [[transformer]].",
    "---END FILE---",
    "",
    "---FILE: wiki/entities/mamba.md---",
    "---",
    "type: entity",
    "title: Mamba",
    `created: ${today}`,
    `updated: ${today}`,
    "tags: [ml, model]",
    "related: [recurrent-neural-network, transformer]",
    `sources: ["${sourceFile}"]`,
    "---",
    "",
    "# Mamba",
    "",
    "Mamba is a state-space model that revisits some [[recurrent-neural-network]] ideas.",
    "---END FILE---",
    "",
    "---FILE: wiki/log.md---",
    `## [${today}] ingest | RNN vs Transformer`,
    "Added recurrent-neural-network and mamba pages.",
    "---END FILE---",
    "",
    "---REVIEW: suggestion | Add Linear Attention page---",
    "Linear attention deserves its own page.",
    "OPTIONS: Create Page | Skip",
    "PAGES: wiki/concepts/transformer.md",
    "SEARCH: linear attention transformer | efficient attention mechanism",
    "---END REVIEW---",
  ].join("\n")
  // Stream in ~200-char chunks to exercise SSE buffering
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += 200) chunks.push(text.slice(i, i + 200))
  return chunks
}

async function runLLMPhase(): Promise<void> {
  await withFakeServer(async (handle) => {
    const env: NodeJS.ProcessEnv = {
      LLM_BASE_URL: handle.baseUrl,
      LLM_API_KEY: "test-key",
      OPENAI_API_KEY: "test-key",
      LLM_MODEL: "fake-model",
      TAVILY_API_KEY: "test-key",
      TAVILY_BASE_URL: handle.baseUrl,
      WIKI_OUTPUT_LANGUAGE: "English",
    }

    // ── ingest ────────────────────────────────────────────────
    handle.pushChat({ match: "expert research analyst", chunks: ingestStage1Reply() })
    handle.pushChat({ match: "wiki maintainer", chunks: ingestStage2Reply("rnn-vs-transformer.md") })
    await runCli("ingest", ["ingest", PROJECT, RAW_SOURCE], env)

    // Verify files actually landed on disk
    const expected = [
      "wiki/sources/rnn-vs-transformer.md",
      "wiki/concepts/recurrent-neural-network.md",
      "wiki/entities/mamba.md",
    ]
    const missing = expected.filter((p) => !fs.existsSync(path.join(PROJECT, p)))
    results[results.length - 1].notes = missing.length === 0
      ? `All expected files written: ${expected.join(", ")}`
      : `MISSING: ${missing.join(", ")}`
    if (missing.length > 0) results[results.length - 1].ok = false

    // ── ingest cache hit (re-run) ────────────────────────────
    await runCli("ingest (cache hit)", ["ingest", PROJECT, RAW_SOURCE], env)
    const cacheCalls = handle.callCount().chat
    results[results.length - 1].notes = `Total LLM chat calls so far: ${cacheCalls} (cache hit should not increment beyond 2)`
    if (cacheCalls > 2) results[results.length - 1].ok = false

    // ── deep-research ────────────────────────────────────────
    handle.pushSearch([
      { title: "Mixture of Experts overview", url: "https://example.com/moe", content: "MoE routes tokens to experts." },
      { title: "Switch Transformer", url: "https://example.com/switch", content: "Sparse expert routing." },
    ])
    const synthesis = [
      "# Mixture of Experts (MoE)",
      "",
      "MoE architectures route tokens to specialized expert sub-networks [1].",
      "[[transformer]] models like Switch Transformer demonstrate sparse expert routing [2].",
      "",
    ].join("\n")
    handle.pushChat({ match: "research assistant", chunks: synthesis.match(/.{1,80}/gs) ?? [synthesis] })
    // The auto-ingest stage runs analysis + generation again on the saved page
    handle.pushChat({ match: "expert research analyst", chunks: ["## Key Concepts\n- MoE\n"] })
    const today = new Date().toISOString().slice(0, 10)
    const moeBlock = [
      `---FILE: wiki/sources/research-mixture-of-experts-${today}.md---`,
      "---",
      "type: source",
      'title: "Source: MoE research"',
      `created: ${today}`,
      `updated: ${today}`,
      `sources: ["research-mixture-of-experts-${today}.md"]`,
      "tags: [ml, research]",
      "related: [mixture-of-experts, transformer]",
      "---",
      "# Source: MoE research",
      "Summary of MoE research.",
      "---END FILE---",
      "",
      "---FILE: wiki/concepts/mixture-of-experts.md---",
      "---",
      "type: concept",
      "title: Mixture of Experts",
      `created: ${today}`,
      `updated: ${today}`,
      "tags: [ml]",
      "related: [transformer]",
      `sources: ["research-mixture-of-experts-${today}.md"]`,
      "---",
      "# Mixture of Experts",
      "Sparse routing across experts. See [[transformer]].",
      "---END FILE---",
    ].join("\n")
    handle.pushChat({ match: "wiki maintainer", chunks: moeBlock.match(/.{1,200}/gs) ?? [moeBlock] })

    await runCli("deep-research", ["deep-research", PROJECT, "Mixture of Experts"], env)
    const moePath = path.join(PROJECT, "wiki/concepts/mixture-of-experts.md")
    const queriesPath = path.join(PROJECT, "wiki/queries")
    const queryFiles = fs.existsSync(queriesPath) ? fs.readdirSync(queriesPath) : []
    results[results.length - 1].notes = [
      `query files: ${queryFiles.join(", ") || "(none)"}`,
      `mixture-of-experts page exists: ${fs.existsSync(moePath)}`,
      `final calls: chat=${handle.callCount().chat}, search=${handle.callCount().search}`,
    ].join(" | ")
    if (!fs.existsSync(moePath) || queryFiles.length === 0) results[results.length - 1].ok = false
  })
}

// ── Phase 3: real MCP JSON-RPC handshake + tool calls ───────────────────────
interface RpcResult { ok: boolean; raw: string; tools?: any[]; result?: any }

async function runMcpPhase(): Promise<void> {
  await withFakeServer(async (handle) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      WIKI_PATH: PROJECT,
      LLM_BASE_URL: handle.baseUrl,
      LLM_API_KEY: "test-key",
      OPENAI_API_KEY: "test-key",
      LLM_MODEL: "fake-model",
      TAVILY_API_KEY: "test-key",
      TAVILY_BASE_URL: handle.baseUrl,
      WIKI_OUTPUT_LANGUAGE: "English",
    }
    const child = spawn(process.execPath, [MCP], { env, stdio: ["pipe", "pipe", "pipe"] })
    let stdoutBuf = ""
    let stderrBuf = ""
    child.stdout.on("data", (d) => { stdoutBuf += d.toString() })
    child.stderr.on("data", (d) => { stderrBuf += d.toString() })

    const sendAndWait = async (req: any): Promise<RpcResult> => {
      const before = stdoutBuf.length
      child.stdin.write(JSON.stringify(req) + "\n")
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50))
        if (stdoutBuf.length > before) {
          const slice = stdoutBuf.slice(before)
          // Find a complete JSON line
          for (const line of slice.split("\n")) {
            if (!line.trim()) continue
            try {
              const parsed = JSON.parse(line)
              if (parsed.id === req.id) {
                return { ok: !parsed.error, raw: line, tools: parsed.result?.tools, result: parsed.result }
              }
            } catch { /* keep waiting */ }
          }
        }
      }
      return { ok: false, raw: stdoutBuf.slice(before) }
    }

    const record = (name: string, req: any, resp: RpcResult, expectOk = true) => {
      results.push({
        name: `mcp:${name}`,
        command: `MCP ${req.method} ${req.params?.name ?? ""}`.trim(),
        exitCode: 0,
        stdout: resp.raw.slice(0, 2000),
        stderr: "",
        ok: expectOk ? resp.ok : !resp.ok,
      })
    }

    // Initialize
    const init = await sendAndWait({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "1.0" } },
    })
    record("initialize", { id: 1, method: "initialize" }, init)

    // List tools
    const list = await sendAndWait({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    record("tools/list", { id: 2, method: "tools/list" }, list)
    const toolNames = (list.tools ?? []).map((t: any) => t.name)
    results[results.length - 1].notes = `tools: ${toolNames.join(", ")}`
    const expectedTools = ["wiki_status", "wiki_search", "wiki_graph", "wiki_insights", "wiki_lint", "wiki_ingest", "wiki_deep_research"]
    const missingTools = expectedTools.filter((t) => !toolNames.includes(t))
    if (missingTools.length > 0) {
      results[results.length - 1].ok = false
      results[results.length - 1].notes += ` | MISSING: ${missingTools.join(", ")}`
    }

    // Call non-LLM tools
    for (const [callId, name, args] of [
      [3, "wiki_status", {}],
      [4, "wiki_search", { query: "transformer" }],
      [5, "wiki_graph", { format: "summary" }],
      [6, "wiki_insights", {}],
      [7, "wiki_lint", {}],
    ] as Array<[number, string, any]>) {
      const r = await sendAndWait({
        jsonrpc: "2.0", id: callId, method: "tools/call",
        params: { name, arguments: args },
      })
      record(name, { id: callId, method: "tools/call", params: { name } }, r)
    }

    // Call wiki_ingest with a fresh raw file
    const RAW2 = path.join(RAW, "moe-deep-dive.md")
    fs.writeFileSync(RAW2, "# MoE deep dive\n\nMixture of experts and routing.\n")
    handle.pushChat({ match: "expert research analyst", chunks: ["## Key Concepts\n- routing\n"] })
    const today = new Date().toISOString().slice(0, 10)
    const block = [
      `---FILE: wiki/sources/moe-deep-dive.md---`,
      "---",
      "type: source",
      'title: "Source: MoE deep dive"',
      `created: ${today}`,
      `updated: ${today}`,
      'sources: ["moe-deep-dive.md"]',
      "tags: [ml]",
      "related: [mixture-of-experts]",
      "---",
      "# Source: MoE deep dive",
      "Re-iterates [[mixture-of-experts]] with deeper analysis.",
      "---END FILE---",
    ].join("\n")
    handle.pushChat({ match: "wiki maintainer", chunks: block.match(/.{1,200}/gs) ?? [block] })

    const ingestRpc = await sendAndWait({
      jsonrpc: "2.0", id: 8, method: "tools/call",
      params: { name: "wiki_ingest", arguments: { source_file: RAW2 } },
    })
    record("wiki_ingest", { id: 8, method: "tools/call", params: { name: "wiki_ingest" } }, ingestRpc)

    // Call wiki_deep_research
    handle.pushSearch([
      { title: "RLHF survey", url: "https://example.com/rlhf", content: "Reinforcement learning from human feedback." },
    ])
    const synthesis = "# RLHF\n\nRLHF aligns LLMs using human preference data [1]."
    handle.pushChat({ match: "research assistant", chunks: synthesis.match(/.{1,40}/gs) ?? [synthesis] })
    handle.pushChat({ match: "expert research analyst", chunks: ["## Key Concepts\n- RLHF\n"] })
    const dr = [
      `---FILE: wiki/sources/research-rlhf-${today}.md---`,
      "---",
      "type: source",
      'title: "Source: RLHF research"',
      `created: ${today}`,
      `updated: ${today}`,
      `sources: ["research-rlhf-${today}.md"]`,
      "tags: [ml]",
      "related: [rlhf]",
      "---",
      "# Source: RLHF research",
      "RLHF research notes.",
      "---END FILE---",
      "",
      "---FILE: wiki/concepts/rlhf.md---",
      "---",
      "type: concept",
      "title: RLHF",
      `created: ${today}`,
      `updated: ${today}`,
      "tags: [ml, alignment]",
      "related: [transformer]",
      `sources: ["research-rlhf-${today}.md"]`,
      "---",
      "# RLHF",
      "Reinforcement learning from human feedback. See [[transformer]].",
      "---END FILE---",
    ].join("\n")
    handle.pushChat({ match: "wiki maintainer", chunks: dr.match(/.{1,200}/gs) ?? [dr] })

    const drRpc = await sendAndWait({
      jsonrpc: "2.0", id: 9, method: "tools/call",
      params: { name: "wiki_deep_research", arguments: { topic: "RLHF" } },
    })
    record("wiki_deep_research", { id: 9, method: "tools/call", params: { name: "wiki_deep_research" } }, drRpc)

    child.kill("SIGTERM")
    await new Promise((r) => setTimeout(r, 200))
    void stderrBuf
  })
}

// ── Run everything and emit report ──────────────────────────────────────────
async function main() {
  await scaffoldFixture()
  await runNonLLMPhase()
  // Phase 2 + 3
  await runLLMPhase()
  await runMcpPhase()

  // Re-run lint after ingest to confirm orphans changed
  await runCli("lint (post-ingest)", ["lint", PROJECT])

  // Build the report
  const lines: string[] = []
  lines.push("# llm-wiki Skill + MCP — End-to-End Test Report")
  lines.push("")
  lines.push(`> Generated: ${new Date().toISOString()}`)
  lines.push(`> Fixture: \`${TMP}\``)
  lines.push(`> Node: ${process.version}`)
  lines.push("")
  lines.push("## Methodology")
  lines.push("")
  lines.push("All cases run **the real built CLI / MCP server** (`dist/cli.js`, `dist/mcp-server.js`)")
  lines.push("against a real on-disk wiki fixture. LLM and Tavily traffic is served by")
  lines.push("`dist/test-server/fake-llm-server.js`, a real local HTTP server that speaks the")
  lines.push("OpenAI-compatible Chat Completions SSE protocol and the Tavily search REST")
  lines.push("protocol — no code-level mocks. The skill code (`llm-client.ts`, `web-search.ts`)")
  lines.push("runs unmodified and exercises real `fetch` / SSE parsing / JSON decoding.")
  lines.push("")
  const passed = results.filter((r) => r.ok).length
  const failed = results.length - passed
  lines.push(`## Summary: ${passed}/${results.length} passed${failed ? `, ${failed} failed` : ""}`)
  lines.push("")
  lines.push("| # | Case | Exit | Status | Notes |")
  lines.push("|---|------|------|--------|-------|")
  results.forEach((r, i) => {
    lines.push(`| ${i + 1} | ${r.name} | ${r.exitCode} | ${r.ok ? "✅ pass" : "❌ fail"} | ${r.notes ?? ""} |`)
  })
  lines.push("")
  lines.push("## Per-case detail")
  lines.push("")
  for (const r of results) {
    lines.push(`### ${r.name}`)
    lines.push("")
    lines.push("```")
    lines.push(`$ ${r.command}`)
    lines.push("```")
    if (r.notes) { lines.push(""); lines.push(`**Notes**: ${r.notes}`); lines.push("") }
    lines.push("**stdout (first 60 lines):**")
    lines.push("```")
    lines.push(r.stdout.split("\n").slice(0, 60).join("\n"))
    lines.push("```")
    if (r.stderr.trim()) {
      lines.push("**stderr (first 30 lines):**")
      lines.push("```")
      lines.push(r.stderr.split("\n").slice(0, 30).join("\n"))
      lines.push("```")
    }
    lines.push("")
  }
  // Final on-disk wiki snapshot
  lines.push("## Final wiki snapshot (file tree)")
  lines.push("")
  lines.push("```")
  function walk(dir: string, prefix = ""): string[] {
    const out: string[] = []
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue
      const full = path.join(dir, e.name)
      out.push(`${prefix}${e.name}${e.isDirectory() ? "/" : ""}`)
      if (e.isDirectory()) out.push(...walk(full, prefix + "  "))
    }
    return out
  }
  lines.push(walk(PROJECT).join("\n"))
  lines.push("```")
  lines.push("")

  const reportPath = path.join(SKILL_ROOT, "docs", "test-report.md")
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(reportPath, lines.join("\n"))
  console.log(`\n[e2e] report written: ${reportPath}`)
  console.log(`[e2e] ${passed}/${results.length} passed`)
  if (failed > 0) process.exitCode = 1
}

main().catch((err) => { console.error(err); process.exit(1) })
