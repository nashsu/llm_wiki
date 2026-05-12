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
