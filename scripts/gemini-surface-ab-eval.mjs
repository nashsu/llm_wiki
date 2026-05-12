#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"

const DEFAULT_VAULT = "/Users/kevin/내 드라이브/LLM WIKI Vault"
const DEFAULT_MODEL = "gemini-3-flash-preview"
const BOOTSTRAP_DOCS = ["purpose.md", "schema.md", "wiki/index.md", "wiki/overview.md"]
const REQUIRED_KEYS = [
  "type",
  "title",
  "created",
  "updated",
  "tags",
  "related",
  "sources",
  "state",
  "confidence",
  "evidence_strength",
  "review_status",
  "knowledge_type",
  "last_reviewed",
]
const QUALITY_KEYS = ["quality", "coverage", "needs_upgrade", "source_count"]

const args = parseArgs(process.argv.slice(2))
const vault = args.vault ?? DEFAULT_VAULT
const model = args.model ?? DEFAULT_MODEL
const apiKey = process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY
if (!apiKey) {
  throw new Error("Missing GOOGLE_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY")
}

const now = new Date()
const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")
const runtimeDir = join(vault, ".llm-wiki", "runtime")
mkdirSync(runtimeDir, { recursive: true })

const beforeDocs = readBootstrapDocs(vault, "before")
const afterDocs = readBootstrapDocs(vault, "after")
const samples = buildSamples()
const results = []

for (const sample of samples) {
  for (const variant of [
    { id: "before", docs: beforeDocs },
    { id: "after", docs: afterDocs },
  ]) {
    const prompt = buildPrompt({ sample, docs: variant.docs, variant: variant.id })
    const startedAt = Date.now()
    const response = await callGemini({ apiKey, model, prompt })
    const elapsedMs = Date.now() - startedAt
    const evaluation = evaluateResponse(response, sample)
    results.push({
      sampleId: sample.id,
      sampleTitle: sample.title,
      variant: variant.id,
      model,
      promptBytes: byteLength(prompt),
      surfaceBytes: variant.docs.totalBytes,
      elapsedMs,
      responseBytes: byteLength(response),
      evaluation,
      responsePreview: response.slice(0, 1200),
    })
    process.stdout.write(`${sample.id} ${variant.id}: ${evaluation.score}/${evaluation.maxScore}\n`)
  }
}

const bySample = samples.map((sample) => {
  const before = results.find((r) => r.sampleId === sample.id && r.variant === "before")
  const after = results.find((r) => r.sampleId === sample.id && r.variant === "after")
  return {
    sampleId: sample.id,
    sampleTitle: sample.title,
    beforeScore: before?.evaluation.score ?? 0,
    afterScore: after?.evaluation.score ?? 0,
    delta: (after?.evaluation.score ?? 0) - (before?.evaluation.score ?? 0),
    maxScore: after?.evaluation.maxScore ?? before?.evaluation.maxScore ?? 0,
  }
})
const beforeTotal = sum(results.filter((r) => r.variant === "before").map((r) => r.evaluation.score))
const afterTotal = sum(results.filter((r) => r.variant === "after").map((r) => r.evaluation.score))
const maxTotal = sum(results.filter((r) => r.variant === "after").map((r) => r.evaluation.maxScore))
const report = {
  schemaVersion: 1,
  generatedAt: now.toISOString(),
  model,
  vault,
  method: "live-gemini-ab-surface-eval",
  bootstrapDocs: BOOTSTRAP_DOCS,
  surfaceBytes: {
    before: beforeDocs.totalBytes,
    after: afterDocs.totalBytes,
    delta: afterDocs.totalBytes - beforeDocs.totalBytes,
    reductionPercent: round1((1 - afterDocs.totalBytes / beforeDocs.totalBytes) * 100),
  },
  totals: {
    beforeScore: beforeTotal,
    afterScore: afterTotal,
    delta: afterTotal - beforeTotal,
    maxScore: maxTotal,
    beforePercent: round1((beforeTotal / maxTotal) * 100),
    afterPercent: round1((afterTotal / maxTotal) * 100),
  },
  bySample,
  results,
}

const jsonPath = join(runtimeDir, `gemini-surface-ab-report-${stamp}.json`)
const mdPath = join(runtimeDir, `gemini-surface-ab-report-${stamp}.md`)
writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n", "utf8")
writeFileSync(mdPath, renderMarkdown(report), "utf8")
writeFileSync(join(runtimeDir, "gemini-surface-ab-report-latest.json"), JSON.stringify(report, null, 2) + "\n", "utf8")
writeFileSync(join(runtimeDir, "gemini-surface-ab-report-latest.md"), renderMarkdown(report), "utf8")
process.stdout.write(`json=${jsonPath}\nmd=${mdPath}\n`)

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--vault") out.vault = argv[++i]
    else if (arg === "--model") out.model = argv[++i]
  }
  return out
}

function readBootstrapDocs(vault, variant) {
  const docs = {}
  let totalBytes = 0
  for (const path of BOOTSTRAP_DOCS) {
    let content
    if (variant === "before") {
      content = execFileSync("git", ["-C", vault, "show", `HEAD:${path}`], { encoding: "utf8" })
    } else {
      content = readFileSync(join(vault, path), "utf8")
    }
    docs[path] = content
    totalBytes += byteLength(content)
  }
  return { docs, totalBytes }
}

function buildSamples() {
  return [
    {
      id: "ko-ops-memo",
      title: "짧은 한국어 운영 메모",
      sourceFileName: "gemini-short-command-memo.md",
      mustHavePathFragment: "wiki/sources/",
      source: [
        "# Gemini 짧은 명령 운영 메모",
        "",
        "짧은 명령은 반복 운영에서 빠르지만, 복잡한 작업에서는 목표, 검증, 제외 범위를 같이 적어야 한다.",
        "Gemini 3 Flash Preview는 빠른 반복에는 좋지만, 긴 운영 문서를 한 번에 주면 schema와 overview의 우선순위가 흐려질 수 있다.",
        "좋은 운영 패턴은 작은 source summary, 필요한 concept 하나, 그리고 검증 질문을 남기는 것이다.",
      ].join("\n"),
    },
    {
      id: "comparison-source",
      title: "비교형 source",
      sourceFileName: "OpenClaw vs Hermes 운영 비교.md",
      mustHavePathFragment: "wiki/comparisons/",
      source: [
        "# OpenClaw vs Hermes 운영 비교",
        "",
        "OpenClaw는 브라우저 중심의 실험 자동화에 강하고, Hermes는 로컬 에이전트 오케스트레이션에 강하다.",
        "| 기준 | OpenClaw | Hermes |",
        "| --- | --- | --- |",
        "| 주 용도 | 웹 실험 자동화 | 로컬 작업 흐름 조율 |",
        "| 위험 | 웹 상태 의존 | 권한/파일 경계 관리 필요 |",
        "결론: 둘은 대체재가 아니라 작업 계층이 다르다. 비교 페이지가 필요하다.",
      ].join("\n"),
    },
    {
      id: "mixed-long-source",
      title: "혼합 주제 긴 source",
      sourceFileName: "AI 운영 표면과 프롬프트 오염 리스크.md",
      mustHavePathFragment: "wiki/concepts/",
      source: [
        "# AI 운영 표면과 프롬프트 오염 리스크",
        "",
        "운영 문서가 길어지면 단순한 성능 문제가 아니라 오래된 판단이 새 판단에 섞이는 prompt contamination risk가 된다.",
        "schema는 계약이어야 하고 overview는 현재 정체성 스냅샷이어야 한다.",
        "log archive는 검색 가능해야 하지만 bootstrap에는 자동 포함되면 안 된다.",
        "index는 전체 목록이 아니라 사람이 보는 compact map이어야 한다.",
        "좋은 ingest는 source trace를 유지하고, 약한 근거는 canonical로 승격하지 않는다.",
        "이 원칙은 Codex, Gemini, Obsidian LLM Wiki 모두에 적용된다.",
      ].join("\n\n"),
    },
  ]
}

function buildPrompt({ sample, docs, variant }) {
  return [
    "You are a strict Obsidian LLM Wiki maintainer.",
    "Return FILE blocks only. Do not add preamble. The first character must be `-` from `---FILE:`.",
    "Use Korean for page titles and body except official product/entity names.",
    "Do not generate wiki/log.md. The app writes logs deterministically.",
    "Do not list archived/deprecated/ephemeral pages in wiki/index.md.",
    "Do not mark canonical unless evidence is moderate or strong, review_status is ai_reviewed or better, and needs_upgrade is false.",
    "Every FILE block must start with YAML frontmatter and include required fields.",
    "Required fields: type, title, created, updated, tags, related, sources, state, confidence, evidence_strength, review_status, knowledge_type, last_reviewed, quality, coverage, needs_upgrade, source_count.",
    "Allowed type: source | entity | concept | comparison | synthesis | query | decision | overview | index.",
    "Allowed state: seed | draft | active | canonical | deprecated | archived.",
    "Allowed quality: seed | draft | reviewed | canonical. Never use gold.",
    "",
    `## Variant\n${variant}`,
    "",
    `## Source File\n${sample.sourceFileName}`,
    "",
    `## Wiki Purpose\n${docs.docs["purpose.md"]}`,
    "",
    `## Wiki Schema\n${docs.docs["schema.md"]}`,
    "",
    `## Current Wiki Index\n${docs.docs["wiki/index.md"]}`,
    "",
    `## Current Overview\n${docs.docs["wiki/overview.md"]}`,
    "",
    `## Source Content\n${sample.source}`,
    "",
    "## Output Format",
    "```",
    "---FILE: wiki/path/file.md---",
    "---",
    "type: source",
    "title: 예시",
    "created: 2026-05-12",
    "updated: 2026-05-12",
    "tags: [example]",
    "related: []",
    `sources: [\"${sample.sourceFileName}\"]`,
    "state: draft",
    "confidence: medium",
    "evidence_strength: moderate",
    "review_status: ai_generated",
    "knowledge_type: operational",
    "last_reviewed: 2026-05-12",
    "quality: draft",
    "coverage: medium",
    "needs_upgrade: true",
    "source_count: 1",
    "---",
    "# 예시",
    "본문",
    "---END FILE---",
    "```",
  ].join("\n")
}

async function callGemini({ apiKey, model, prompt }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 8192 },
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`Gemini HTTP ${res.status}: ${body}`)
  }
  const json = await res.json()
  const text = json.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? ""
  if (!text.trim()) throw new Error("Gemini returned empty text")
  return text.trim()
}

function evaluateResponse(response, sample) {
  const blocks = parseFileBlocks(response)
  const checks = []
  add(checks, "startsWithFileBlock", response.trimStart().startsWith("---FILE:"), 8)
  add(checks, "hasClosedFileBlock", blocks.length > 0, 8)
  add(checks, "noLogFileGenerated", !blocks.some((b) => normalizePath(b.path) === "wiki/log.md"), 8)
  add(checks, "requiredPathPresent", blocks.some((b) => normalizePath(b.path).includes(sample.mustHavePathFragment)), 10)
  add(checks, "reasonablePageCount", blocks.length >= 2 && blocks.length <= 6, 6)
  add(checks, "requiredFrontmatter", blocks.length > 0 && blocks.every((b) => hasRequiredFrontmatter(b.frontmatter)), 12)
  add(checks, "sourceTrace", blocks.length > 0 && blocks.every((b) => String(b.frontmatter.sources ?? "").includes(sample.sourceFileName)), 10)
  add(checks, "qualityValues", blocks.length > 0 && blocks.every((b) => ["seed", "draft", "reviewed", "canonical"].includes(String(b.frontmatter.quality ?? ""))), 6)
  add(checks, "canonicalGate", blocks.every(canonicalGateOk), 8)
  add(checks, "koreanOutput", hangulRatio(blocks.map((b) => b.content).join("\n")) > 0.12, 8)
  add(checks, "thinPageGuard", blocks.length > 0 && blocks.every((b) => b.body.trim().length >= 220 || normalizePath(b.path).endsWith("wiki/index.md") || normalizePath(b.path).endsWith("wiki/overview.md")), 8)
  add(checks, "indexHygiene", indexHygieneOk(blocks), 6)
  add(checks, "overviewCurrentOnly", overviewCurrentOnlyOk(blocks), 4)
  const score = sum(checks.map((c) => c.passed ? c.points : 0))
  const maxScore = sum(checks.map((c) => c.points))
  return { score, maxScore, percent: round1((score / maxScore) * 100), blocks: blocks.map(summarizeBlock), checks }
}

function parseFileBlocks(text) {
  const regex = /---FILE:\s*([^\n]+?)\s*---\n([\s\S]*?)---END FILE---/g
  const blocks = []
  let match
  while ((match = regex.exec(text)) !== null) {
    const path = match[1].trim()
    const content = match[2].trim()
    const { frontmatter, body } = parseFrontmatter(content)
    blocks.push({ path, content, frontmatter, body })
  }
  return blocks
}

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) return { frontmatter: {}, body: content }
  const frontmatter = {}
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":")
    if (idx < 0) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "")
    frontmatter[key] = value
  }
  return { frontmatter, body: match[2] }
}

function hasRequiredFrontmatter(fm) {
  return [...REQUIRED_KEYS, ...QUALITY_KEYS].every((key) => Object.prototype.hasOwnProperty.call(fm, key))
}

function canonicalGateOk(block) {
  const state = String(block.frontmatter.state ?? "")
  const quality = String(block.frontmatter.quality ?? "")
  if (state !== "canonical" && quality !== "canonical") return true
  const evidence = String(block.frontmatter.evidence_strength ?? "")
  const review = String(block.frontmatter.review_status ?? "")
  const needsUpgrade = String(block.frontmatter.needs_upgrade ?? "")
  return ["moderate", "strong"].includes(evidence) && ["ai_reviewed", "human_reviewed", "validated"].includes(review) && needsUpgrade === "false"
}

function indexHygieneOk(blocks) {
  const index = blocks.find((b) => normalizePath(b.path).endsWith("wiki/index.md"))
  if (!index) return true
  return !/retention:\s*(ephemeral|archive)|state:\s*(archived|deprecated)|archived|deprecated/iu.test(index.content)
}

function overviewCurrentOnlyOk(blocks) {
  const overview = blocks.find((b) => normalizePath(b.path).endsWith("wiki/overview.md"))
  if (!overview) return true
  return !/전체 역사|taxonomy evolution|deprecated direction|오래된 design rationale|history of the wiki/iu.test(overview.content)
}

function summarizeBlock(block) {
  return {
    path: block.path,
    type: block.frontmatter.type ?? "",
    title: block.frontmatter.title ?? basename(block.path),
    state: block.frontmatter.state ?? "",
    quality: block.frontmatter.quality ?? "",
    bodyChars: block.body.trim().length,
  }
}

function add(checks, id, passed, points) {
  checks.push({ id, passed: Boolean(passed), points })
}

function hangulRatio(text) {
  if (!text.trim()) return 0
  const hangul = (text.match(/[가-힣]/g) ?? []).length
  const letters = (text.match(/[A-Za-z가-힣]/g) ?? []).length || 1
  return hangul / letters
}

function normalizePath(path) {
  return path.replace(/\\/g, "/").trim()
}

function byteLength(text) {
  return Buffer.byteLength(text, "utf8")
}

function sum(values) {
  return values.reduce((acc, value) => acc + value, 0)
}

function round1(value) {
  return Math.round(value * 10) / 10
}

function renderMarkdown(report) {
  const lines = [
    "# Gemini Surface A/B Report",
    "",
    `- generated_at: ${report.generatedAt}`,
    `- model: ${report.model}`,
    `- before_surface_bytes: ${report.surfaceBytes.before}`,
    `- after_surface_bytes: ${report.surfaceBytes.after}`,
    `- surface_reduction: ${report.surfaceBytes.reductionPercent}%`,
    `- before_score: ${report.totals.beforeScore}/${report.totals.maxScore} (${report.totals.beforePercent}%)`,
    `- after_score: ${report.totals.afterScore}/${report.totals.maxScore} (${report.totals.afterPercent}%)`,
    `- delta: ${report.totals.delta}`,
    "",
    "| sample | before | after | delta |",
    "| --- | ---: | ---: | ---: |",
  ]
  for (const sample of report.bySample) {
    lines.push(`| ${sample.sampleTitle} | ${sample.beforeScore}/${sample.maxScore} | ${sample.afterScore}/${sample.maxScore} | ${sample.delta} |`)
  }
  lines.push("", "## Failed Checks")
  for (const result of report.results) {
    const failed = result.evaluation.checks.filter((check) => !check.passed)
    lines.push("", `### ${result.sampleTitle} / ${result.variant}`, failed.length ? failed.map((check) => `- ${check.id} (${check.points})`).join("\n") : "- none")
  }
  return lines.join("\n") + "\n"
}
