import { describe, expect, it, vi } from "vitest"
import fs from "node:fs/promises"
import path from "node:path"
import { realFs } from "@/test-helpers/fs-temp"

vi.mock("@/commands/fs", () => realFs)

import { autoIngest } from "@/lib/ingest"
import { refreshProjectMaintenanceQueue } from "@/lib/maintenance-refresh"
import { OPERATIONAL_SURFACE_POLICY } from "@/lib/wiki-operational-surface"
import { useActivityStore } from "@/stores/activity-store"
import { useChatStore } from "@/stores/chat-store"
import { useReviewStore } from "@/stores/review-store"
import { useWikiStore } from "@/stores/wiki-store"
import {
  buildSmokeProofRetentionPlan,
  buildSmokeProofRun,
  classifySmokeProof,
  countGuardedReasons,
  smokeProofStampFromFileName,
  type SmokeProofGuardedReasonDetail,
  type SmokeProofRun,
} from "../../scripts/lib/live-ingest-smoke-retention.mjs"

const DEFAULT_VAULT = "/Users/kevin/내 드라이브/LLM WIKI Vault"
const RUN_SMOKE = process.env.RUN_LIVE_INGEST_SMOKE === "1"
const SMOKE_RETENTION_POLICY = OPERATIONAL_SURFACE_POLICY.runtimeProofRetention.liveIngestSmoke

describe("live Vault ingest smoke", () => {
  const runIfEnabled = RUN_SMOKE ? it : it.skip

  runIfEnabled("ingests one runtime source with Gemini and keeps smoke output proof-only", async () => {
    const apiKey = process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY
    expect(apiKey, "GOOGLE_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY is required").toBeTruthy()

    const vault = process.env.LLM_WIKI_VAULT_PATH || DEFAULT_VAULT
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")
    const runtimeDir = path.join(vault, ".llm-wiki", "runtime")
    const sourcePath = path.join(runtimeDir, `codex-live-ingest-smoke-${stamp}.md`)
    const proofPath = path.join(runtimeDir, `codex-live-ingest-smoke-${stamp}.json`)
    const latestProofPath = path.join(runtimeDir, "codex-live-ingest-smoke-latest.json")
    const indexPath = path.join(vault, "wiki/index.md")
    const overviewPath = path.join(vault, "wiki/overview.md")
    const beforeIndex = await fs.readFile(indexPath, "utf8").catch(() => "")
    const beforeOverview = await fs.readFile(overviewPath, "utf8").catch(() => "")

    await fs.mkdir(runtimeDir, { recursive: true })
    await fs.writeFile(sourcePath, [
      "# Codex live ingest smoke",
      "",
      "이 메모는 LLM Wiki App의 실제 Vault ingest 경로를 검증하기 위한 짧은 운영 source입니다.",
      "핵심 주장은 세 가지입니다.",
      "",
      "- bootstrap surface는 얇게 유지해야 합니다.",
      "- malformed FILE block은 focused retry 또는 단일 파일 폴백으로 복구해야 합니다.",
      "- recovery metric은 health/report에서 장기 추적되어야 합니다.",
    ].join("\n"))

    resetStores(vault)
    const written = await autoIngest(
      vault,
      sourcePath,
      {
        provider: "google",
        apiKey: apiKey!,
        model: process.env.LLM_WIKI_SMOKE_MODEL || "gemini-3-flash-preview",
        ollamaUrl: "",
        customEndpoint: "",
        maxContextSize: 128000,
      },
    )

    const bootstrapWrites = written.filter((file) => file === "wiki/index.md" || file === "wiki/overview.md")
    const proofOnlyPaths = await markSmokeOutputsProofOnly(vault, written, {
      includeExtraWikiWrites: process.env.LLM_WIKI_SMOKE_FIXTURE === "1",
    })
    const unexpectedWrites = written.filter((file) =>
      file !== "wiki/log.md" &&
      file !== "wiki/index.md" &&
      file !== "wiki/overview.md" &&
      !proofOnlyPaths.includes(file),
    )
    await rolloverLogIfNeeded(vault)

    const afterIndex = await fs.readFile(indexPath, "utf8").catch(() => "")
    const afterOverview = await fs.readFile(overviewPath, "utf8").catch(() => "")
    const indexChanged = beforeIndex !== afterIndex
    const overviewChanged = beforeOverview !== afterOverview
    if (indexChanged) await fs.writeFile(indexPath, beforeIndex)
    if (overviewChanged) await fs.writeFile(overviewPath, beforeOverview)
    await refreshProjectMaintenanceQueue(vault)

    const recoveryMetrics = await readJsonIfExists(path.join(runtimeDir, "ingest-recovery-metrics.json"))
    const health = await readJsonIfExists(path.join(vault, ".llm-wiki/health.json"))
    const proof = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      sourcePath,
      written,
      proofOnlyPaths,
      unexpectedWrites,
      guardedBootstrapWrites: bootstrapWrites,
      revertedBootstrapDocs: [
        ...(indexChanged ? ["wiki/index.md"] : []),
        ...(overviewChanged ? ["wiki/overview.md"] : []),
      ],
      indexChanged,
      overviewChanged,
      activity: useActivityStore.getState().items[0] ?? null,
      reviewCount: useReviewStore.getState().items.length,
      recoveryMetrics,
      healthOperationalSurface: health?.operationalSurface ?? null,
      guardedReasons: [] as string[],
      guardedReasonDetails: [] as SmokeProofGuardedReasonDetail[],
      retention: null as SmokeProofRetentionReport | null,
      monthlySummary: null as SmokeProofMonthlySummaryReport | null,
    }
    const classification = classifySmokeProof(proof)
    proof.guardedReasons = classification.reasons
    proof.guardedReasonDetails = classification.reasonDetails
    await fs.writeFile(proofPath, JSON.stringify(proof, null, 2))
    proof.retention = await applySmokeProofRetention(runtimeDir, {
      retainRuns: readPositiveIntEnv("LLM_WIKI_SMOKE_RETENTION_RUNS", SMOKE_RETENTION_POLICY.retainRuns),
      retainFailedOrGuardedRuns: readPositiveIntEnv(
        "LLM_WIKI_SMOKE_RETENTION_FAILED_RUNS",
        SMOKE_RETENTION_POLICY.retainFailedOrGuardedRuns,
      ),
      prune: process.env.LLM_WIKI_SMOKE_PRUNE_PROOFS === "1",
    })
    await fs.writeFile(proofPath, JSON.stringify(proof, null, 2))
    proof.monthlySummary = await writeSmokeProofMonthlySummary(runtimeDir, proof.retention, proofPath, proof)
    await fs.writeFile(proofPath, JSON.stringify(proof, null, 2))
    await fs.writeFile(latestProofPath, JSON.stringify(proof, null, 2))

    expect(written.some((file) => file.startsWith("wiki/sources/"))).toBe(true)
    expect(unexpectedWrites).toEqual([])
    expect(await fs.readFile(indexPath, "utf8")).toBe(beforeIndex)
    expect(await fs.readFile(overviewPath, "utf8")).toBe(beforeOverview)
  }, 240_000)
})

function resetStores(vault: string) {
  useReviewStore.setState({ items: [] })
  useActivityStore.setState({ items: [] })
  useChatStore.setState({
    conversations: [],
    messages: [],
    activeConversationId: null,
    mode: "chat",
    ingestSource: null,
    isStreaming: false,
    streamingContent: "",
  })
  useWikiStore.setState({
    project: {
      name: "LLM WIKI Vault",
      path: vault,
      createdAt: Date.now(),
      purposeText: "",
      fileTree: [],
    } as unknown as ReturnType<typeof useWikiStore.getState>["project"],
    outputLanguage: "Korean",
  })
}

async function markSmokeOutputsProofOnly(
  vault: string,
  written: string[],
  options: { includeExtraWikiWrites: boolean },
): Promise<string[]> {
  const proofOnlyPaths: string[] = []
  for (const relPath of written.filter((file) => isSmokeProofOnlyCandidate(file, options.includeExtraWikiWrites))) {
    const fullPath = path.join(vault, relPath)
    let content = await fs.readFile(fullPath, "utf8").catch(() => "")
    if (
      !options.includeExtraWikiWrites &&
      !content.includes("codex-live-ingest-smoke") &&
      !content.includes("Codex live ingest smoke")
    ) {
      continue
    }
    content = normalizeSmokeProofOnlyContent(content, relPath)
    if (!content.includes("## Proof Boundary")) {
      content += [
        "",
        "## Proof Boundary",
        "",
        "- 이 문서는 실제 Vault ingest smoke의 산출물 보존용 proof입니다.",
        "- 장기 운영 지식이나 canonical source로 승격하지 않습니다.",
        "- bootstrap/index/overview 입력에는 포함하지 않습니다.",
      ].join("\n")
    }
    await fs.writeFile(fullPath, content)
    proofOnlyPaths.push(relPath)
  }
  return proofOnlyPaths
}

function isSmokeProofOnlyCandidate(relPath: string, includeExtraWikiWrites: boolean): boolean {
  if (!relPath.startsWith("wiki/") || !relPath.endsWith(".md")) return false
  if (relPath === "wiki/log.md" || relPath === "wiki/index.md" || relPath === "wiki/overview.md") return false
  return includeExtraWikiWrites || relPath.startsWith("wiki/sources/")
}

function normalizeSmokeProofOnlyContent(content: string, relPath: string): string {
  const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "")
  const title = path.basename(relPath, ".md")
  const sources = Array.from(new Set(
    Array.from(content.matchAll(/codex-live-ingest-smoke-\d{8}T\d{6}Z\.md/g)).map((match) => match[0]),
  ))
  const sourceLines = sources.length > 0
    ? sources.map((source) => `  - "${source}"`).join("\n")
    : "  - \"codex-live-ingest-smoke.md\""
  return [
    "---",
    `type: ${relPath.startsWith("wiki/sources/") ? "source" : "proof"}`,
    `title: ${title}`,
    "created: 2026-05-12",
    "updated: 2026-05-12",
    "tags:",
    "  - 운영",
    "  - 인제스트",
    "  - 안정성",
    "  - 스모크테스트",
    "  - test-proof",
    "  - ingest",
    "  - smoke-test",
    "  - recovery",
    "  - bootstrap",
    "related:",
    "  - \"[[LLM Wiki 운영 워크플로]]\"",
    "  - \"[[수용 프로세스 (Ingest Process)]]\"",
    "  - \"[[위키 린팅 (Wiki Linting)]]\"",
    "sources:",
    sourceLines,
    "state: archived",
    "confidence: medium",
    "evidence_strength: weak",
    "review_status: ai_generated",
    "retention: proof-only",
    "test_proof: true",
    "bootstrap_include: false",
    "knowledge_type: conceptual",
    "last_reviewed: 2026-05-12",
    "quality: draft",
    "coverage: medium",
    "needs_upgrade: true",
    `source_count: ${Math.max(1, sources.length)}`,
    "freshness_required: true",
    "archive_reason: live ingest smoke proof; not durable wiki knowledge",
    "---",
    body.trimStart(),
  ].join("\n")
}

async function rolloverLogIfNeeded(vault: string) {
  const logPath = path.join(vault, "wiki/log.md")
  const archivePath = path.join(vault, ".llm-wiki/log-archive/2026-05.md")
  const text = await fs.readFile(logPath, "utf8").catch(() => "")
  const matches = [...text.matchAll(/^## \[\d{4}-\d{2}-\d{2}\][^\n]*$/gm)]
  if (matches.length <= 50) return

  const firstStart = matches[0].index ?? 0
  const header = text.slice(0, firstStart).trimEnd()
  const entries = matches.map((match, index) => {
    const start = match.index ?? 0
    const end = index + 1 < matches.length ? matches[index + 1].index ?? text.length : text.length
    return text.slice(start, end).trimEnd()
  })
  const keep = entries.slice(0, 50)
  const archive = entries.slice(50)
  await fs.writeFile(logPath, `${header}\n\n${keep.join("\n\n")}\n`)
  await fs.mkdir(path.dirname(archivePath), { recursive: true })
  let archiveText = await fs.readFile(archivePath, "utf8").catch(() => "# LLM Wiki Log Archive - 2026-05\n")
  archiveText = archiveText.trimEnd()
  for (const entry of archive) {
    if (!archiveText.includes(entry.split("\n")[0])) {
      archiveText += `\n\n${entry}`
    }
  }
  await fs.writeFile(archivePath, `${archiveText}\n`)
}

async function readJsonIfExists(filePath: string) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"))
  } catch {
    return null
  }
}

interface SmokeProofRetentionReport {
  policy: {
    retainRuns: number
    retainFailedOrGuardedRuns: number
    prune: boolean
  }
  totalRuns: number
  retainedRuns: string[]
  failedOrGuardedRuns: string[]
  guardedReasonCounts: Record<string, number>
  deleteCandidates: string[]
  deleted: string[]
}

interface SmokeProofMonthlySummaryReport {
  month: string
  path: string
  latestPath: string
  totalRuns: number
  passedRuns: number
  failedOrGuardedRuns: number
  unexpectedWriteRuns: number
  guardedBootstrapWriteRuns: number
  retentionDeleteCandidates: number
  retentionDeleted: number
  guardedReasonCounts: Record<string, number>
  latestProof: string
}

async function applySmokeProofRetention(runtimeDir: string, policy: {
  retainRuns: number
  retainFailedOrGuardedRuns: number
  prune: boolean
}): Promise<SmokeProofRetentionReport> {
  const runs = await collectSmokeProofRuns(runtimeDir)
  const plan = buildSmokeProofRetentionPlan(runs, policy)
  const deleted: string[] = []
  if (policy.prune) {
    for (const file of plan.deleteCandidates) {
      await fs.rm(path.join(runtimeDir, file), { force: true })
      deleted.push(file)
    }
  }
  return {
    policy,
    ...plan,
    deleted,
  }
}

async function collectSmokeProofRuns(runtimeDir: string): Promise<SmokeProofRun[]> {
  const names = await fs.readdir(runtimeDir).catch(() => [])
  const grouped = new Map<string, string[]>()
  for (const name of names) {
    const stamp = smokeProofStampFromFileName(name)
    if (!stamp) continue
    grouped.set(stamp, [...(grouped.get(stamp) ?? []), name])
  }
  const runs = await Promise.all(Array.from(grouped.entries()).map(async ([stamp, files]) => {
    const proof = files.includes(`codex-live-ingest-smoke-${stamp}.json`)
      ? await readJsonIfExists(path.join(runtimeDir, `codex-live-ingest-smoke-${stamp}.json`))
      : null
    return buildSmokeProofRun(stamp, files, proof)
  }))
  return runs.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))
}

async function writeSmokeProofMonthlySummary(
  runtimeDir: string,
  retention: SmokeProofRetentionReport,
  proofPath: string,
  proof: {
    generatedAt: string
    healthOperationalSurface: { status?: string; recovery?: unknown } | null
  },
): Promise<SmokeProofMonthlySummaryReport> {
  const month = proof.generatedAt.slice(0, 7)
  const monthlyPath = path.join(runtimeDir, `codex-live-ingest-smoke-monthly-${month}.md`)
  const latestPath = path.join(runtimeDir, "codex-live-ingest-smoke-monthly-latest.md")
  const runs = (await collectSmokeProofRuns(runtimeDir)).filter((run) => run.generatedAt.startsWith(month))
  const failedOrGuardedRuns = runs.filter((run) => run.failedOrGuarded).length
  const unexpectedWriteRuns = runs.filter((run) => run.unexpectedWrite).length
  const guardedBootstrapWriteRuns = runs.filter((run) => run.guardedBootstrapWrite).length
  const guardedReasonCounts = countGuardedReasons(runs)
  const report: SmokeProofMonthlySummaryReport = {
    month,
    path: `.llm-wiki/runtime/${path.basename(monthlyPath)}`,
    latestPath: ".llm-wiki/runtime/codex-live-ingest-smoke-monthly-latest.md",
    totalRuns: runs.length,
    passedRuns: Math.max(0, runs.length - failedOrGuardedRuns),
    failedOrGuardedRuns,
    unexpectedWriteRuns,
    guardedBootstrapWriteRuns,
    retentionDeleteCandidates: retention.deleteCandidates.length,
    retentionDeleted: retention.deleted.length,
    guardedReasonCounts,
    latestProof: `.llm-wiki/runtime/${path.basename(proofPath)}`,
  }
  const text = renderSmokeProofMonthlySummary(report, proof)
  await fs.writeFile(monthlyPath, text)
  await fs.writeFile(latestPath, text)
  return report
}

function renderSmokeProofMonthlySummary(
  report: SmokeProofMonthlySummaryReport,
  proof: {
    generatedAt: string
    healthOperationalSurface: { status?: string; recovery?: unknown } | null
  },
): string {
  const healthStatus = proof.healthOperationalSurface?.status ?? "unknown"
  return [
    `# Codex Live Ingest Smoke Monthly Summary - ${report.month}`,
    "",
    "> Runtime artifact only. Do not include this summary in bootstrap, index, or overview context.",
    "",
    `- generated_at: ${proof.generatedAt}`,
    `- latest_proof: ${report.latestProof}`,
    `- health_status: ${healthStatus}`,
    "",
    "## Counts",
    "",
    "| Metric | Value |",
    "|---|---:|",
    `| total_runs | ${report.totalRuns} |`,
    `| passed_runs | ${report.passedRuns} |`,
    `| failed_or_guarded_runs | ${report.failedOrGuardedRuns} |`,
    `| unexpected_write_runs | ${report.unexpectedWriteRuns} |`,
    `| guarded_bootstrap_write_runs | ${report.guardedBootstrapWriteRuns} |`,
    `| retention_delete_candidates | ${report.retentionDeleteCandidates} |`,
    `| retention_deleted | ${report.retentionDeleted} |`,
    "",
    "## Guarded Reasons",
    "",
    renderGuardedReasonRows(report.guardedReasonCounts),
    "",
    "## Boundary",
    "",
    "- Detailed run data stays in per-run JSON proof files.",
    "- This summary is for runtime observability and cleanup review only.",
    "",
  ].join("\n")
}

function renderGuardedReasonRows(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))
  if (entries.length === 0) return "- none"
  return [
    "| Reason | Runs |",
    "|---|---:|",
    ...entries.map(([reason, count]) => `| ${reason} | ${count} |`),
  ].join("\n")
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name])
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  return Math.floor(parsed)
}
