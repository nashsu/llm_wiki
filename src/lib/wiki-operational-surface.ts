export type OperationalSurfaceStatus = "ok" | "warn" | "fail"

export const OPERATIONAL_SURFACE_POLICY = {
  docs: {
    purpose: { path: "purpose.md", warnLines: 100, failLines: 140, capBytes: 7 * 1024 },
    schema: { path: "schema.md", warnLines: 250, failLines: 320, capBytes: 12 * 1024 },
    index: { path: "wiki/index.md", warnLines: 220, failLines: 260, capBytes: 14 * 1024 },
    overview: { path: "wiki/overview.md", warnLines: 120, failLines: 160, capBytes: 8 * 1024 },
  },
  log: { warnEntries: 50, failEntries: 60 },
  ingestSurface: { warnBytes: 45 * 1024, failBytes: 60 * 1024 },
  runtimeProofRetention: {
    liveIngestSmoke: {
      retainRuns: 8,
      retainFailedOrGuardedRuns: 4,
      latestPointer: ".llm-wiki/runtime/codex-live-ingest-smoke-latest.json",
      artifactPrefix: "codex-live-ingest-smoke-",
    },
  },
  excludedFromBootstrap: [
    ".llm-wiki/policy/*",
    ".llm-wiki/log-archive/*",
    ".llm-wiki/runtime/*",
    "state: archived",
    "state: deprecated",
  ],
} as const

export type OperationalSurfaceDocId = keyof typeof OPERATIONAL_SURFACE_POLICY.docs

export interface OperationalSurfaceDocReport {
  path: string
  lineCount: number
  byteLength: number
  status: OperationalSurfaceStatus
  warnLines: number
  failLines: number
  capBytes: number
  truncatedForIngest: boolean
}

export interface OperationalSurfaceLogReport {
  path: "wiki/log.md"
  lineCount: number
  byteLength: number
  entryCount: number
  status: OperationalSurfaceStatus
  rolloverNeeded: boolean
  warnEntries: number
  failEntries: number
}

export interface OperationalSurfaceReport {
  status: OperationalSurfaceStatus
  controlSurfaceBytes: number
  ingestPromptSurfaceBytes: number
  ingestPromptSurfaceStatus: OperationalSurfaceStatus
  recovery: OperationalSurfaceRecoveryReport
  runtimeProofRetention: typeof OPERATIONAL_SURFACE_POLICY.runtimeProofRetention
  capsApplied: boolean
  deterministicTruncation: true
  promptContaminationRisk: {
    archivesExcludedFromBootstrap: true
    deepPolicyExcludedFromBootstrap: true
    runtimeArtifactsExcludedFromBootstrap: true
    archivedOrDeprecatedPagesExcluded: true
  }
  excludedFromBootstrap: readonly string[]
  docs: {
    purpose: OperationalSurfaceDocReport
    schema: OperationalSurfaceDocReport
    index: OperationalSurfaceDocReport
    overview: OperationalSurfaceDocReport
    log: OperationalSurfaceLogReport
  }
}

export interface IngestRecoveryMetricsInput {
  totals?: Partial<{
    malformedFileFocusedRetryAttempts: number
    malformedFileFocusedRetryRecovered: number
    oneFileFallbackAttempts: number
    oneFileFallbackRecovered: number
  }>
  latest?: Partial<{
    at: string
    sourceFileName: string
  }>
  weekly?: Record<string, Partial<IngestRecoveryWeekReport>>
}

export interface OperationalSurfaceRecoveryReport {
  malformedFileFocusedRetryAttempts: number
  malformedFileFocusedRetryRecovered: number
  oneFileFallbackAttempts: number
  oneFileFallbackRecovered: number
  latestAt: string | null
  latestSource: string | null
  currentWeek: IngestRecoveryWeekReport
}

export interface IngestRecoveryWeekReport {
  weekKey: string
  weekStart: string
  malformedFileFocusedRetryAttempts: number
  malformedFileFocusedRetryRecovered: number
  oneFileFallbackAttempts: number
  oneFileFallbackRecovered: number
}

export interface IngestSurfaceInput {
  purpose: string
  schema: string
  index: string
  overview: string
}

export interface IngestSurfaceDocSnapshot {
  id: OperationalSurfaceDocId
  path: string
  originalBytes: number
  includedBytes: number
  capBytes: number
  truncated: boolean
}

export interface IngestSurfaceSnapshot {
  schemaVersion: 1
  generatedAt: string
  deterministic: true
  totalOriginalBytes: number
  totalIncludedBytes: number
  warnBytes: number
  failBytes: number
  docs: IngestSurfaceDocSnapshot[]
  excludedSections: readonly string[]
}

export interface PreparedIngestSurfaceDoc {
  content: string
  originalBytes: number
  includedBytes: number
  capBytes: number
  truncated: boolean
}

export interface PreparedIngestSurface {
  docs: Record<OperationalSurfaceDocId, PreparedIngestSurfaceDoc>
  totalOriginalBytes: number
  totalIncludedBytes: number
  snapshot: IngestSurfaceSnapshot
}

const DOC_ORDER: OperationalSurfaceDocId[] = ["purpose", "schema", "index", "overview"]

export function buildOperationalSurfaceReport(input: IngestSurfaceInput & {
  log: string
  logEntryCount: number
  logRolloverNeeded: boolean
  recoveryMetrics?: IngestRecoveryMetricsInput | null
  now?: Date
}): OperationalSurfaceReport {
  const prepared = prepareIngestSurface(input, input.now)
  const docs = {
    purpose: buildDocReport("purpose", input.purpose, prepared.docs.purpose.truncated),
    schema: buildDocReport("schema", input.schema, prepared.docs.schema.truncated),
    index: buildDocReport("index", input.index, prepared.docs.index.truncated),
    overview: buildDocReport("overview", input.overview, prepared.docs.overview.truncated),
    log: buildLogReport(input.log, input.logEntryCount, input.logRolloverNeeded),
  }
  const ingestPromptSurfaceStatus = statusFromThreshold(
    prepared.totalIncludedBytes,
    OPERATIONAL_SURFACE_POLICY.ingestSurface.warnBytes,
    OPERATIONAL_SURFACE_POLICY.ingestSurface.failBytes,
  )
  return {
    status: maxStatus([
      ingestPromptSurfaceStatus,
      docs.purpose.status,
      docs.schema.status,
      docs.index.status,
      docs.overview.status,
      docs.log.status,
    ]),
    controlSurfaceBytes: byteLength(input.purpose) + byteLength(input.schema) + byteLength(input.index) + byteLength(input.overview) + byteLength(input.log),
    ingestPromptSurfaceBytes: prepared.totalIncludedBytes,
    ingestPromptSurfaceStatus,
    recovery: normalizeRecoveryMetrics(input.recoveryMetrics, input.now ?? new Date()),
    runtimeProofRetention: OPERATIONAL_SURFACE_POLICY.runtimeProofRetention,
    capsApplied: Object.values(prepared.docs).some((doc) => doc.truncated),
    deterministicTruncation: true,
    promptContaminationRisk: {
      archivesExcludedFromBootstrap: true,
      deepPolicyExcludedFromBootstrap: true,
      runtimeArtifactsExcludedFromBootstrap: true,
      archivedOrDeprecatedPagesExcluded: true,
    },
    excludedFromBootstrap: OPERATIONAL_SURFACE_POLICY.excludedFromBootstrap,
    docs,
  }
}

function normalizeRecoveryMetrics(metrics: IngestRecoveryMetricsInput | null | undefined, now: Date): OperationalSurfaceRecoveryReport {
  const currentWeekKey = weekKeyForDate(now)
  const currentWeek = normalizeRecoveryWeek(currentWeekKey, metrics?.weekly?.[currentWeekKey])
  return {
    malformedFileFocusedRetryAttempts: Math.max(0, Number(metrics?.totals?.malformedFileFocusedRetryAttempts ?? 0)),
    malformedFileFocusedRetryRecovered: Math.max(0, Number(metrics?.totals?.malformedFileFocusedRetryRecovered ?? 0)),
    oneFileFallbackAttempts: Math.max(0, Number(metrics?.totals?.oneFileFallbackAttempts ?? 0)),
    oneFileFallbackRecovered: Math.max(0, Number(metrics?.totals?.oneFileFallbackRecovered ?? 0)),
    latestAt: typeof metrics?.latest?.at === "string" ? metrics.latest.at : null,
    latestSource: typeof metrics?.latest?.sourceFileName === "string" ? metrics.latest.sourceFileName : null,
    currentWeek,
  }
}

function normalizeRecoveryWeek(weekKey: string, week?: Partial<IngestRecoveryWeekReport>): IngestRecoveryWeekReport {
  return {
    weekKey,
    weekStart: typeof week?.weekStart === "string" ? week.weekStart : weekStartForWeekKey(weekKey),
    malformedFileFocusedRetryAttempts: Math.max(0, Number(week?.malformedFileFocusedRetryAttempts ?? 0)),
    malformedFileFocusedRetryRecovered: Math.max(0, Number(week?.malformedFileFocusedRetryRecovered ?? 0)),
    oneFileFallbackAttempts: Math.max(0, Number(week?.oneFileFallbackAttempts ?? 0)),
    oneFileFallbackRecovered: Math.max(0, Number(week?.oneFileFallbackRecovered ?? 0)),
  }
}

export function prepareIngestSurface(input: IngestSurfaceInput, now: Date = new Date()): PreparedIngestSurface {
  const docs = {} as Record<OperationalSurfaceDocId, PreparedIngestSurfaceDoc>
  let totalOriginalBytes = 0
  let totalIncludedBytes = 0
  const snapshots: IngestSurfaceDocSnapshot[] = []

  for (const id of DOC_ORDER) {
    const policy = OPERATIONAL_SURFACE_POLICY.docs[id]
    const original = input[id] ?? ""
    const prepared = deterministicTruncate(original, policy.capBytes)
    docs[id] = prepared
    totalOriginalBytes += prepared.originalBytes
    totalIncludedBytes += prepared.includedBytes
    snapshots.push({
      id,
      path: policy.path,
      originalBytes: prepared.originalBytes,
      includedBytes: prepared.includedBytes,
      capBytes: prepared.capBytes,
      truncated: prepared.truncated,
    })
  }

  return {
    docs,
    totalOriginalBytes,
    totalIncludedBytes,
    snapshot: {
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      deterministic: true,
      totalOriginalBytes,
      totalIncludedBytes,
      warnBytes: OPERATIONAL_SURFACE_POLICY.ingestSurface.warnBytes,
      failBytes: OPERATIONAL_SURFACE_POLICY.ingestSurface.failBytes,
      docs: snapshots,
      excludedSections: OPERATIONAL_SURFACE_POLICY.excludedFromBootstrap,
    },
  }
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

export function countLines(text: string): number {
  if (!text) return 0
  return text.split(/\r?\n/).length
}

function buildDocReport(
  id: OperationalSurfaceDocId,
  content: string,
  truncatedForIngest: boolean,
): OperationalSurfaceDocReport {
  const policy = OPERATIONAL_SURFACE_POLICY.docs[id]
  const lineCount = countLines(content)
  const byteLengthValue = byteLength(content)
  const status = !content.trim()
    ? "warn"
    : statusFromThreshold(lineCount, policy.warnLines, policy.failLines)
  return {
    path: policy.path,
    lineCount,
    byteLength: byteLengthValue,
    status,
    warnLines: policy.warnLines,
    failLines: policy.failLines,
    capBytes: policy.capBytes,
    truncatedForIngest,
  }
}

function buildLogReport(content: string, entryCount: number, rolloverNeeded: boolean): OperationalSurfaceLogReport {
  const policy = OPERATIONAL_SURFACE_POLICY.log
  const status = entryCount > policy.failEntries ? "fail" : rolloverNeeded || entryCount > policy.warnEntries ? "warn" : "ok"
  return {
    path: "wiki/log.md",
    lineCount: countLines(content),
    byteLength: byteLength(content),
    entryCount,
    status,
    rolloverNeeded,
    warnEntries: policy.warnEntries,
    failEntries: policy.failEntries,
  }
}

function deterministicTruncate(content: string, capBytes: number): PreparedIngestSurfaceDoc {
  const originalBytes = byteLength(content)
  if (originalBytes <= capBytes) {
    return { content, originalBytes, includedBytes: originalBytes, capBytes, truncated: false }
  }

  const marker = `\n\n<!-- ingest-surface-truncated: original_bytes=${originalBytes} cap_bytes=${capBytes} -->`
  const kept: string[] = []
  for (const line of content.split(/\r?\n/)) {
    const candidate = `${kept.concat(line).join("\n")}${marker}`
    if (byteLength(candidate) > capBytes) break
    kept.push(line)
  }
  const truncatedContent = `${kept.join("\n").trimEnd()}${marker}`
  return {
    content: truncatedContent,
    originalBytes,
    includedBytes: byteLength(truncatedContent),
    capBytes,
    truncated: true,
  }
}

function statusFromThreshold(value: number, warn: number, fail: number): OperationalSurfaceStatus {
  if (value > fail) return "fail"
  if (value > warn) return "warn"
  return "ok"
}

function maxStatus(statuses: OperationalSurfaceStatus[]): OperationalSurfaceStatus {
  if (statuses.includes("fail")) return "fail"
  if (statuses.includes("warn")) return "warn"
  return "ok"
}

function weekKeyForDate(date: Date): string {
  const weekStart = startOfUtcWeek(date)
  const yearStart = startOfUtcWeek(new Date(Date.UTC(weekStart.getUTCFullYear(), 0, 1)))
  const weekNumber = Math.floor((weekStart.getTime() - yearStart.getTime()) / (7 * 24 * 60 * 60 * 1000)) + 1
  return `${weekStart.getUTCFullYear()}-W${String(weekNumber).padStart(2, "0")}`
}

function weekStartForWeekKey(weekKey: string): string {
  const match = weekKey.match(/^(\d{4})-W(\d{2})$/)
  if (!match) return ""
  const year = Number(match[1])
  const week = Number(match[2])
  const yearStart = startOfUtcWeek(new Date(Date.UTC(year, 0, 1)))
  const start = new Date(yearStart.getTime() + (week - 1) * 7 * 24 * 60 * 60 * 1000)
  return start.toISOString().slice(0, 10)
}

function startOfUtcWeek(date: Date): Date {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const day = start.getUTCDay()
  const diff = day === 0 ? -6 : 1 - day
  start.setUTCDate(start.getUTCDate() + diff)
  return start
}
