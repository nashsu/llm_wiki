#!/usr/bin/env node
// Run after npm install: node scripts/benchmark-retrieval-links.mjs
// Microbenchmark only: excludes disk I/O, graph assembly, LLM calls and UI rendering.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import { performance } from "node:perf_hooks"

const require = createRequire(import.meta.url)
const ts = require("typescript")
const baselineCommit = "e8082119649e6a8e1cf85eaf289adcabfdf39d4e"
const sourcePath = new URL("../src/lib/graph-relevance.ts", import.meta.url)
const source = readFileSync(sourcePath, "utf8")
const parsed = ts.createSourceFile(sourcePath.pathname, source, ts.ScriptTarget.Latest, true)
const helpers = ["buildTargetIndex", "resolveTarget"].map((name) => {
  const declaration = parsed.statements.find((statement) =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name)
  assert.ok(declaration, `Missing production helper: ${name}`)
  return declaration.getText(parsed)
}).join("\n")
// Execute the actual production helpers, not a separately maintained optimized copy.
const compiled = ts.transpileModule(helpers, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  reportDiagnostics: true,
})
assert.equal(compiled.diagnostics?.length ?? 0, 0)
const { buildTargetIndex, resolveTarget } = new Function(
  `${compiled.outputText}\nreturn { buildTargetIndex, resolveTarget };`,
)()

// Frozen original algorithm, with TypeScript annotations removed only.
function baselineResolveTarget(raw, nodeIds) {
  if (nodeIds.has(raw)) return raw
  const normalized = raw.toLowerCase().replace(/\s+/g, "-")
  for (const id of nodeIds) {
    const idLower = id.toLowerCase()
    if (idLower === normalized) return id
    if (idLower === raw.toLowerCase()) return id
    if (idLower.replace(/\s+/g, "-") === normalized) return id
  }
  return null
}

// Deterministic differential coverage includes every insertion order for colliding IDs.
function* permutations(values) {
  if (values.length === 0) { yield []; return }
  for (let i = 0; i < values.length; i++) {
    for (const rest of permutations(values.filter((_, j) => j !== i))) {
      yield [values[i], ...rest]
    }
  }
}
let comparisons = 0
for (const order of permutations(["Page Name", "page-name", "PAGE NAME", "page\tname"])) {
  const nodeIds = new Set([...order, "ÉTUDE 中", "étude-中", "", "__proto__", "Σ", "ς"])
  const index = buildTargetIndex(nodeIds)
  const targets = [
    ...nodeIds,
    "Page\u00a0Name", "PAGE  NAME", "PAGE-NAME", "ÉTUDE\t中", "σ", "__PROTO__", "missing", "toString",
  ]
  for (const raw of targets) {
    assert.equal(resolveTarget(raw, nodeIds, index), baselineResolveTarget(raw, nodeIds))
    comparisons++
  }
}

const offsets = [1, 7, 17, 31, 53, 97, 193, 389]
function makeFixture(n, mode) {
  const ids = Array.from({ length: n }, (_, i) => `page-${String(i).padStart(5, "0")}`)
  const nodeIds = new Set(ids)
  const targets = [], expected = []
  for (let i = 0; i < n; i++) {
    for (const offset of offsets) {
      const j = (i + offset) % n
      targets.push(mode === "exact" ? ids[j] : `${mode === "alias" ? "Page" : "Missing"} ${String(j).padStart(5, "0")}`)
      expected.push(mode === "missing" ? null : ids[j])
    }
  }
  return { nodeIds, targets, expected }
}

function runBaseline({ nodeIds, targets }) {
  return targets.map((raw) => baselineResolveTarget(raw, nodeIds))
}
function runIndexed({ nodeIds, targets }) {
  // Index construction is deliberately INSIDE the timed region on every run.
  const index = buildTargetIndex(nodeIds)
  return targets.map((raw) => resolveTarget(raw, nodeIds, index))
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
let sink
function timed(run, fixture) {
  const start = performance.now()
  sink = run(fixture)
  return performance.now() - start
}
function measure(n, mode) {
  const fixture = makeFixture(n, mode)
  assert.deepEqual(runBaseline(fixture), fixture.expected)
  assert.deepEqual(runIndexed(fixture), fixture.expected)
  for (let i = 0; i < 2; i++) {
    timed(runBaseline, fixture)
    timed(runIndexed, fixture)
  }
  const baselineSamplesMs = [], indexedSamplesMs = []
  for (let i = 0; i < 5; i++) {
    // Alternate execution order between samples.
    if (i % 2 === 0) {
      baselineSamplesMs.push(timed(runBaseline, fixture))
      indexedSamplesMs.push(timed(runIndexed, fixture))
    } else {
      indexedSamplesMs.push(timed(runIndexed, fixture))
      baselineSamplesMs.push(timed(runBaseline, fixture))
    }
  }
  return {
    pages: n, links: fixture.targets.length, mode,
    baselineMedianMs: median(baselineSamplesMs),
    indexedMedianMs: median(indexedSamplesMs),
    baselineSamplesMs, indexedSamplesMs,
    // Formula for this uniform fixture, not measured instrumentation.
    baselineCandidateVisits: mode === "exact" ? 0 : mode === "missing"
      ? n * fixture.targets.length : offsets.length * n * (n + 1) / 2,
  }
}

const rows = []
for (const n of [1000, 2000, 3000]) {
  for (const mode of ["alias", "missing", "exact"]) {
    const row = measure(n, mode)
    rows.push(row)
    console.error(`${mode} N=${n}: ${row.baselineMedianMs.toFixed(2)} ms -> ${row.indexedMedianMs.toFixed(2)} ms`)
  }
}
console.log(JSON.stringify({
  baselineCommit,
  environment: { node: process.version, platform: process.platform, architecture: process.arch, cpu: os.cpus()[0]?.model },
  method: { warmupPasses: 2, measuredPasses: 5, statistic: "median", indexedTimingIncludesIndexBuild: true, scope: "link resolution only" },
  differentialComparisons: comparisons,
  rows, sinkLength: sink.length,
}, null, 2))
