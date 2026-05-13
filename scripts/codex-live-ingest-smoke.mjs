#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildSmokeProofRetentionPlan,
  buildSmokeProofRun,
  smokeProofStampFromFileName,
} from "./lib/live-ingest-smoke-retention.mjs"

const DEFAULT_RETAIN_RUNS = 8
const DEFAULT_RETAIN_FAILED_RUNS = 4

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  printHelp()
  process.exit(0)
}
const argsError = validateArgs(args)
if (argsError) {
  console.error(argsError)
  printHelp()
  process.exit(1)
}

const vault = args.fixture ? createFixtureVault() : args.vault
const model = args.model ?? "gemini-3-flash-preview"
const retainRuns = parsePositiveInt(args.retainRuns, DEFAULT_RETAIN_RUNS)
const retainFailedRuns = parsePositiveInt(args.retainFailedRuns, DEFAULT_RETAIN_FAILED_RUNS)
const apiKey = process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY
const validation = validateVault(vault)

if (args.dryRun) {
  const retentionPreview = buildSmokeProofRetentionPreview(join(vault, ".llm-wiki", "runtime"), {
    retainRuns,
    retainFailedRuns,
  })
  console.log(JSON.stringify({
    ok: validation.ok,
    mode: args.pruneProofs ? "prune-preview" : "dry-run",
    vault,
    model,
    apiKeyPresent: Boolean(apiKey),
    retention: {
      retainRuns,
      retainFailedRuns,
      pruneProofs: Boolean(args.pruneProofs),
      action: args.pruneProofs ? "preview-delete-candidates" : "report-only",
      ...retentionPreview,
    },
    checks: validation.checks,
  }, null, 2))
  process.exit(validation.ok ? 0 : 1)
}

if (!apiKey) {
  console.error("Missing GOOGLE_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY")
  process.exit(1)
}
if (!validation.ok) {
  console.error(`Not an LLM Wiki Vault: ${vault}`)
  for (const check of validation.checks) {
    if (!check.ok) console.error(`- missing: ${check.path}`)
  }
  process.exit(1)
}

const result = spawnSync(
  "./node_modules/.bin/vitest",
  ["run", "src/lib/live-ingest-smoke.real-llm.test.ts", "--reporter=verbose"],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      RUN_LIVE_INGEST_SMOKE: "1",
      LLM_WIKI_VAULT_PATH: vault,
      LLM_WIKI_SMOKE_MODEL: model,
      LLM_WIKI_SMOKE_RETENTION_RUNS: String(retainRuns),
      LLM_WIKI_SMOKE_RETENTION_FAILED_RUNS: String(retainFailedRuns),
      LLM_WIKI_SMOKE_PRUNE_PROOFS: args.pruneProofs ? "1" : "0",
      LLM_WIKI_SMOKE_FIXTURE: args.fixture ? "1" : "0",
    },
    stdio: "inherit",
  },
)

if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 1)

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--help" || arg === "-h") out.help = true
    else if (arg === "--dry-run") out.dryRun = true
    else if (arg === "--live") out.live = true
    else if (arg === "--fixture") out.fixture = true
    else if (arg === "--prune-proofs") out.pruneProofs = true
    else if (arg === "--vault") out.vault = argv[++i]
    else if (arg.startsWith("--vault=")) out.vault = arg.slice("--vault=".length)
    else if (arg === "--model") out.model = argv[++i]
    else if (arg.startsWith("--model=")) out.model = arg.slice("--model=".length)
    else if (arg === "--retain-runs") out.retainRuns = argv[++i]
    else if (arg.startsWith("--retain-runs=")) out.retainRuns = arg.slice("--retain-runs=".length)
    else if (arg === "--retain-failed-runs") out.retainFailedRuns = argv[++i]
    else if (arg.startsWith("--retain-failed-runs=")) out.retainFailedRuns = arg.slice("--retain-failed-runs=".length)
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return out
}

function validateArgs(args) {
  if (args.dryRun && args.live) {
    return "Choose either --dry-run or --live, not both."
  }
  if (!args.dryRun && !args.live) {
    return "Choose --dry-run for safe validation or --live for the explicit Gemini smoke."
  }
  if (!args.fixture && !args.vault) {
    return "Choose --fixture or --vault <path>; no default real Vault is used."
  }
  return null
}

function validateVault(vault) {
  const paths = [
    "purpose.md",
    "schema.md",
    "wiki",
    "wiki/index.md",
    "wiki/overview.md",
    ".llm-wiki",
  ]
  const checks = paths.map((path) => ({ path, ok: existsSync(join(vault, path)) }))
  return { ok: checks.every((check) => check.ok), checks }
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  return Math.floor(parsed)
}

function createFixtureVault() {
  const vault = mkdtempSync(join(tmpdir(), "llm-wiki-live-ingest-vault-"))
  mkdirSync(join(vault, ".llm-wiki", "runtime"), { recursive: true })
  mkdirSync(join(vault, "wiki"), { recursive: true })
  writeFileSync(join(vault, ".llm-wiki", "review.json"), "[]\n")
  writeFileSync(join(vault, ".llm-wiki", "ingest-queue.json"), "[]\n")
  writeFileSync(
    join(vault, "purpose.md"),
    [
      "# Purpose",
      "",
      "This temporary fixture wiki validates LLM Wiki App ingest behavior with synthetic content only.",
    ].join("\n"),
  )
  writeFileSync(
    join(vault, "schema.md"),
    [
      "# Schema",
      "",
      "- Write concise markdown pages with YAML frontmatter.",
      "- Include source trace and avoid creating unsupported links.",
      "- Keep index and overview compact.",
    ].join("\n"),
  )
  writeFileSync(join(vault, "wiki", "index.md"), "# Index\n\n")
  writeFileSync(join(vault, "wiki", "overview.md"), "# Overview\n\nSynthetic fixture wiki.\n")
  writeFileSync(join(vault, "wiki", "log.md"), "# Log\n\n")
  console.log(`Using synthetic fixture vault: ${vault}`)
  return vault
}

function buildSmokeProofRetentionPreview(runtimeDir, policy) {
  const runs = collectSmokeProofRuns(runtimeDir)
  const plan = buildSmokeProofRetentionPlan(runs, {
    retainRuns: policy.retainRuns,
    retainFailedOrGuardedRuns: policy.retainFailedRuns,
  })
  return {
    ...plan,
    wouldDeleteCount: plan.deleteCandidates.length,
    deletedCount: 0,
  }
}

function collectSmokeProofRuns(runtimeDir) {
  if (!existsSync(runtimeDir)) return []
  const grouped = new Map()
  for (const name of readdirSync(runtimeDir)) {
    const stamp = smokeProofStampFromFileName(name)
    if (!stamp) continue
    grouped.set(stamp, [...(grouped.get(stamp) ?? []), name])
  }
  const runs = Array.from(grouped.entries()).map(([stamp, files]) => {
    const proofName = `codex-live-ingest-smoke-${stamp}.json`
    const proof = files.includes(proofName) ? readJsonIfExists(join(runtimeDir, proofName)) : null
    return buildSmokeProofRun(stamp, files, proof)
  })
  return runs.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"))
  } catch {
    return null
  }
}

function printHelp() {
  console.log(`Usage: npm run smoke:live-ingest -- [options]

Options:
  --dry-run                  Validate vault, model, and retention policy without calling Gemini.
  --live                     Explicitly run the Gemini smoke. Requires --fixture or --vault.
  --dry-run --prune-proofs   Preview proof files that would be deleted; never deletes files.
  --fixture                  Use a temporary synthetic vault instead of the user's real Vault.
  --vault <path>             LLM Wiki Vault path. No default real Vault path is used.
  --model <name>             Gemini model name.
  --retain-runs <n>          Keep newest N smoke proof runs. Default: ${DEFAULT_RETAIN_RUNS}.
  --retain-failed-runs <n>   Keep newest N failed/guarded proof runs in addition. Default: ${DEFAULT_RETAIN_FAILED_RUNS}.
  --prune-proofs             With --dry-run, preview delete candidates. With --live, delete proof artifacts outside the retention policy.
`)
}
