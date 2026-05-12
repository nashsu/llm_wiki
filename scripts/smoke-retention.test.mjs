import test from "node:test"
import assert from "node:assert/strict"
import {
  buildSmokeProofRetentionPlan,
  buildSmokeProofRun,
  classifySmokeProof,
} from "./lib/live-ingest-smoke-retention.mjs"

test("classifies guarded smoke proof reasons", () => {
  const classification = classifySmokeProof({
    unexpectedWrites: ["wiki/concepts/Unexpected.md"],
    guardedBootstrapWrites: ["wiki/index.md"],
    overviewChanged: true,
    healthOperationalSurface: { status: "warn" },
  })

  assert.equal(classification.failedOrGuarded, true)
  assert.deepEqual(classification.reasons, [
    "unexpected-write",
    "guarded-bootstrap-write",
    "health-warn",
  ])
  assert.deepEqual(classification.reasonDetails.map((detail) => detail.code), [
    "unexpected_write",
    "guarded_bootstrap_write",
    "health_warn",
  ])
})

test("plans retention from the same run model used by script and live smoke", () => {
  const runs = [
    buildSmokeProofRun("20260512T000300Z", ["codex-live-ingest-smoke-20260512T000300Z.json"], {
      generatedAt: "2026-05-12T00:03:00.000Z",
    }),
    buildSmokeProofRun("20260512T000200Z", ["codex-live-ingest-smoke-20260512T000200Z.json"], {
      generatedAt: "2026-05-12T00:02:00.000Z",
      guardedBootstrapWrites: ["wiki/index.md"],
    }),
    buildSmokeProofRun("20260512T000100Z", ["codex-live-ingest-smoke-20260512T000100Z.json"], {
      generatedAt: "2026-05-12T00:01:00.000Z",
    }),
  ]

  const plan = buildSmokeProofRetentionPlan(runs, {
    retainRuns: 1,
    retainFailedOrGuardedRuns: 1,
  })

  assert.deepEqual(plan.retainedRuns, ["20260512T000300Z", "20260512T000200Z"])
  assert.deepEqual(plan.deleteCandidates, ["codex-live-ingest-smoke-20260512T000100Z.json"])
  assert.equal(plan.guardedReasonCounts["guarded-bootstrap-write"], 1)
})
