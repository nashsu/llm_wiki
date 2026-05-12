export interface SmokeProofClassification {
  failedOrGuarded: boolean
  unexpectedWrite: boolean
  guardedBootstrapWrite: boolean
  healthStatus: string | null
  reasons: string[]
  reasonDetails: SmokeProofGuardedReasonDetail[]
}

export interface SmokeProofGuardedReasonDetail {
  code: "unexpected_write" | "guarded_bootstrap_write" | "health_warn" | "health_fail"
  severity: "warn" | "fail"
  summary: string
  paths: string[]
  count: number
}

export interface SmokeProofRun extends SmokeProofClassification {
  stamp: string
  files: string[]
  generatedAt: string
}

export interface SmokeProofRetentionPlan {
  totalRuns: number
  retainedRuns: string[]
  failedOrGuardedRuns: string[]
  guardedReasonCounts: Record<string, number>
  deleteCandidates: string[]
}

export const SMOKE_PROOF_ARTIFACT_PATTERN: RegExp
export function smokeProofStampFromFileName(fileName: string): string | null
export function buildSmokeProofRun(stamp: string, files: string[], proof: unknown): SmokeProofRun
export function buildSmokeProofRetentionPlan(
  runs: SmokeProofRun[],
  policy: { retainRuns: number; retainFailedOrGuardedRuns: number },
): SmokeProofRetentionPlan
export function classifySmokeProof(proof: unknown): SmokeProofClassification
export function buildGuardedReasonDetails(proof: unknown): SmokeProofGuardedReasonDetail[]
export function countGuardedReasons(runs: SmokeProofRun[]): Record<string, number>
export function stampToIso(stamp: string): string
