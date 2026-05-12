export const SMOKE_PROOF_ARTIFACT_PATTERN = /^codex-live-ingest-smoke-(\d{8}T\d{6}Z)\.(json|md)$/

export function smokeProofStampFromFileName(fileName) {
  return SMOKE_PROOF_ARTIFACT_PATTERN.exec(fileName)?.[1] ?? null
}

export function buildSmokeProofRun(stamp, files, proof) {
  const classification = classifySmokeProof(proof)
  return {
    stamp,
    files: [...files].sort(),
    generatedAt: typeof proof?.generatedAt === "string" ? proof.generatedAt : stampToIso(stamp),
    ...classification,
  }
}

export function buildSmokeProofRetentionPlan(runs, policy) {
  const newestRuns = runs.slice(0, policy.retainRuns)
  const failedOrGuardedRuns = runs.filter((run) => run.failedOrGuarded)
  const retained = new Set([
    ...newestRuns.map((run) => run.stamp),
    ...failedOrGuardedRuns.slice(0, policy.retainFailedOrGuardedRuns).map((run) => run.stamp),
  ])
  const deleteCandidates = runs
    .filter((run) => !retained.has(run.stamp))
    .flatMap((run) => run.files)
    .sort()
  return {
    totalRuns: runs.length,
    retainedRuns: Array.from(retained).sort().reverse(),
    failedOrGuardedRuns: failedOrGuardedRuns.map((run) => run.stamp),
    guardedReasonCounts: countGuardedReasons(runs),
    deleteCandidates,
  }
}

export function classifySmokeProof(proof) {
  const details = buildGuardedReasonDetails(proof)
  const healthStatus = proof && typeof proof === "object" && typeof proof.healthOperationalSurface?.status === "string"
    ? proof.healthOperationalSurface.status
    : null

  return {
    failedOrGuarded: details.length > 0,
    unexpectedWrite: details.some((detail) => detail.code === "unexpected_write"),
    guardedBootstrapWrite: details.some((detail) => detail.code === "guarded_bootstrap_write"),
    healthStatus,
    reasons: details.map((detail) => detail.code.replaceAll("_", "-")),
    reasonDetails: details,
  }
}

export function buildGuardedReasonDetails(proof) {
  if (!proof || typeof proof !== "object") return []

  const details = []
  const unexpectedWrites = Array.isArray(proof.unexpectedWrites) ? proof.unexpectedWrites : []
  if (unexpectedWrites.length > 0) {
    details.push({
      code: "unexpected_write",
      severity: "fail",
      summary: "Unexpected files were written during live ingest smoke.",
      paths: unexpectedWrites,
      count: unexpectedWrites.length,
    })
  }

  const guardedPaths = new Set(Array.isArray(proof.guardedBootstrapWrites) ? proof.guardedBootstrapWrites : [])
  if (proof.indexChanged === true) guardedPaths.add("wiki/index.md")
  if (proof.overviewChanged === true) guardedPaths.add("wiki/overview.md")
  if (guardedPaths.size > 0) {
    details.push({
      code: "guarded_bootstrap_write",
      severity: "warn",
      summary: "Bootstrap docs changed and were restored.",
      paths: Array.from(guardedPaths).sort(),
      count: guardedPaths.size,
    })
  }

  const healthStatus = typeof proof.healthOperationalSurface?.status === "string"
    ? proof.healthOperationalSurface.status
    : null
  if (healthStatus === "warn" || healthStatus === "fail") {
    details.push({
      code: healthStatus === "fail" ? "health_fail" : "health_warn",
      severity: healthStatus,
      summary: `Operational surface health was ${healthStatus}.`,
      paths: [".llm-wiki/health.json"],
      count: 1,
    })
  }

  return details
}

export function countGuardedReasons(runs) {
  const counts = {}
  for (const run of runs) {
    for (const reason of run.reasons ?? []) {
      counts[reason] = (counts[reason] ?? 0) + 1
    }
  }
  return counts
}

export function stampToIso(stamp) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp)
  if (!match) return stamp
  const [, year, month, day, hour, minute, second] = match
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`
}
