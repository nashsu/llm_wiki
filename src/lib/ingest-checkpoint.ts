import { readFile, writeFileAtomic, deleteFile, fileExists } from "@/commands/fs"
import { normalizePath, isAbsolutePath } from "@/lib/path-utils"
import type { AnalysisEntity } from "@/lib/analysis"

/**
 * Incremental checkpoint for a single `autoIngest` run on one source file.
 * The pipeline writes the checkpoint after Stage 1 finishes and after every
 * Stage 2a / catch-up batch lands on disk; if the run is interrupted
 * (LLM error, app crash, project switch), the next retry loads the
 * checkpoint and skips the LLM calls that already produced output.
 *
 * Invalidation: `contentHash` is SHA-256 of the source file's content.
 * If the source changes between runs the checkpoint is discarded — the
 * earlier work is for a different document and must not be reused.
 *
 * Lifecycle:
 *   - created (or loaded) at the start of `autoIngest`
 *   - updated after Stage 1 and after each batch completion
 *   - deleted when the ingest run succeeds (success path in `ingestFile`)
 */
export interface IngestCheckpoint {
  version: 1
  contentHash: string

  // ── Stage 1: analysis ──
  // All four are set together once `runChunkedAnalysis` returns; absence
  // of `analysis` means Stage 1 has not yet completed.
  analysis?: string
  chunkCount?: number
  isMultiChunk?: boolean

  // ── Stage 2a: main entity batches ──
  // `mainBatchesTotal` is the batch count derived from the parsed manifest
  // (kept on disk so a corrupt re-parse doesn't shift indices). The
  // `completedMainBatches` list tracks which batch indices have already
  // landed on disk; the loop skips them on resume.
  mainBatchesTotal?: number
  completedMainBatches?: number[]
  mainWrittenPaths?: string[]

  // ── Follow-up: catch-up batches ──
  // `catchupTargets` is set once after `findCatchupManifestEntities`
  // runs. An empty array means "scan ran, nothing to catch up" — we
  // distinguish this from "scan hasn't run yet" (the field is absent).
  // Pinning the target list across runs keeps batch indices stable
  // even though subsequent runs would re-scan disk and see a smaller
  // set (because some catch-up pages already landed).
  catchupTargets?: AnalysisEntity[]
  completedCatchupBatches?: number[]
  catchupWrittenPaths?: string[]

  // ── Catch-up retry queue (entity-level, not full re-ingest) ──
  // Pages still missing after a catch-up batch are merged here.
  // Drained after all pinned catch-up batches (≤2 rounds by default).
  pendingCatchupRetries?: AnalysisEntity[]
  catchupRetryRoundsDone?: number

  startedAt: number
  updatedAt: number
}

async function sha256(content: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(content)
  const hashBuffer = await crypto.subtle.digest("SHA-256", data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("")
}

function checkpointSlug(sourceFileName: string): string {
  // The slug only needs to be filesystem-safe and unique per source name;
  // collisions across different filenames within one project would cause
  // two ingests to clobber each other's progress. The replace covers
  // every char outside ASCII alnum / `.` / `_` / `-`; if the slug ends
  // up empty (pathological all-symbol filename) fall back to a stable
  // hash of the original so we still produce a usable path.
  const cleaned = sourceFileName.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
  return cleaned.length > 0 ? cleaned : "unnamed"
}

export function checkpointPath(projectPath: string, sourceFileName: string): string {
  return `${normalizePath(projectPath)}/.llm-wiki/ingest-checkpoint-${checkpointSlug(sourceFileName)}.json`
}

/**
 * Load a checkpoint matching this source's current content. Returns
 * `null` when the file is absent, malformed, has the wrong version,
 * was written for a different content hash, OR when any of the pages
 * the checkpoint claims as "already written" is no longer on disk.
 *
 * The file-existence pass mirrors `checkIngestCache` and exists so a
 * `cancelTask` cleanup (which wipes the run's partial output) doesn't
 * leave behind a checkpoint whose `completedMainBatches` would cause
 * the next run to skip batches whose pages no longer exist.
 */
export async function loadCheckpoint(
  projectPath: string,
  sourceFileName: string,
  sourceContent: string,
): Promise<IngestCheckpoint | null> {
  try {
    const raw = await readFile(checkpointPath(projectPath, sourceFileName))
    const parsed = JSON.parse(raw) as IngestCheckpoint
    if (parsed.version !== 1) return null
    const currentHash = await sha256(sourceContent)
    if (parsed.contentHash !== currentHash) return null

    const pp = normalizePath(projectPath)
    const allWritten = [
      ...(parsed.mainWrittenPaths ?? []),
      ...(parsed.catchupWrittenPaths ?? []),
    ]
    for (const filePath of allWritten) {
      const fullPath = isAbsolutePath(filePath)
        ? normalizePath(filePath)
        : `${pp}/${filePath}`
      try {
        if (!(await fileExists(fullPath))) {
          console.log(
            `[ingest-checkpoint] stale (${filePath} missing); discarding checkpoint for "${sourceFileName}"`,
          )
          return null
        }
      } catch {
        return null
      }
    }

    return parsed
  } catch {
    return null
  }
}

/**
 * Create a fresh checkpoint for `sourceContent`. Caller is responsible
 * for calling `saveCheckpoint` once stages start producing data worth
 * persisting (we don't write an empty checkpoint to disk).
 */
export async function newCheckpoint(sourceContent: string): Promise<IngestCheckpoint> {
  const now = Date.now()
  return {
    version: 1,
    contentHash: await sha256(sourceContent),
    startedAt: now,
    updatedAt: now,
  }
}

/**
 * Persist the checkpoint. Atomic write so a crash mid-write can't
 * corrupt the file. Failures are swallowed: checkpointing is best-
 * effort instrumentation, never load-bearing for correctness.
 */
export async function saveCheckpoint(
  projectPath: string,
  sourceFileName: string,
  checkpoint: IngestCheckpoint,
): Promise<void> {
  try {
    const updated: IngestCheckpoint = { ...checkpoint, updatedAt: Date.now() }
    await writeFileAtomic(
      checkpointPath(projectPath, sourceFileName),
      JSON.stringify(updated, null, 2),
    )
  } catch {
    // non-critical
  }
}

/**
 * Remove the checkpoint file. Called from the success path of the
 * ingest pipeline so the next re-ingest (e.g. after source edit) starts
 * fresh. Silent when the file does not exist.
 */
export async function clearCheckpoint(
  projectPath: string,
  sourceFileName: string,
): Promise<void> {
  try {
    await deleteFile(checkpointPath(projectPath, sourceFileName))
  } catch {
    // non-critical — file may not exist
  }
}
