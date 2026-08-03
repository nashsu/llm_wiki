import { preprocessFile } from "@/commands/fs"

export const MIN_PARSING_CONCURRENCY = 1
export const MAX_PARSING_CONCURRENCY = 8

export function normalizeParsingConcurrency(value: number): number {
  if (!Number.isFinite(value)) return MIN_PARSING_CONCURRENCY
  return Math.max(
    MIN_PARSING_CONCURRENCY,
    Math.min(MAX_PARSING_CONCURRENCY, Math.floor(value)),
  )
}

interface WaitingParser {
  limit: number
  resolve: () => void
}

let activeParsers = 0
const waitingParsers: WaitingParser[] = []

function drainWaitingParsers(): void {
  while (waitingParsers.length > 0 && activeParsers < waitingParsers[0].limit) {
    const waiter = waitingParsers.shift()
    if (!waiter) return
    activeParsers += 1
    waiter.resolve()
  }
}

async function acquireParser(limit: number): Promise<() => void> {
  await new Promise<void>((resolve) => {
    waitingParsers.push({ limit, resolve })
    drainWaitingParsers()
  })
  let released = false
  return () => {
    if (released) return
    released = true
    activeParsers -= 1
    drainWaitingParsers()
  }
}

/**
 * Pre-extract source text with bounded concurrency before LLM work begins.
 * Individual extractor failures are intentionally non-fatal: autoIngest will
 * retry through read_file and surface a real source-read error if necessary.
 */
export async function preprocessSourceFiles(
  paths: readonly string[],
  concurrency: number,
): Promise<void> {
  const uniquePaths = [...new Set(paths)]
  if (uniquePaths.length === 0) return
  const limit = normalizeParsingConcurrency(concurrency)

  await Promise.all(uniquePaths.map(async (path) => {
    const release = await acquireParser(limit)
    try {
      try {
        await preprocessFile(path)
      } catch (err) {
        console.warn(
          `[source-preprocess] failed to pre-process "${path}"; ingest will retry when reading it:`,
          err instanceof Error ? err.message : err,
        )
      }
    } finally {
      release()
    }
  }))
}
