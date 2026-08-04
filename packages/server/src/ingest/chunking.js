// Semantic chunking + long-source checkpoint persistence for server-driven
// ingest (port of the chunking section of src/lib/ingest.ts, ~lines 2492-2704).
//
// PORT VERBATIM: regexes, magic numbers, and algorithms are byte-identical to
// the client source. hashTextHex is a 64-bit FNV-1a over UTF-16 code units —
// checkpoint file names and resume compatibility depend on bit-exact output,
// so do not touch it.
//
// Everything takes plain parameters; budget computation (sourceBudget →
// targetChars/overlapChars clamps) lives in prompts.js and is NOT done here.
//
// Browser→Node swaps: @/commands/fs readFile/writeFile/createDirectory/
// fileExists/deleteFile → node:fs/promises. normalizePath is inlined from
// @/lib/path-utils.

import { mkdir, readFile as fsReadFile, rm, stat, writeFile as fsWriteFile } from "node:fs/promises"

function normalizePath(p) {
  return p.replace(/\\/g, "/")
}

function splitOversizedBlock(block, targetChars) {
  if (block.length <= targetChars * 1.25) return [block]

  const pieces = block.match(/[^.!?。！？\n]+[.!?。！？]?|\n+/g) ?? [block]
  const out = []
  let current = ""
  for (const piece of pieces) {
    if (current && current.length + piece.length > targetChars) {
      out.push(current.trim())
      current = ""
    }
    if (piece.length > targetChars) {
      for (let i = 0; i < piece.length; i += targetChars) {
        const slice = piece.slice(i, i + targetChars).trim()
        if (slice) out.push(slice)
      }
    } else {
      current += piece
    }
  }
  if (current.trim()) out.push(current.trim())
  return out
}

function semanticBlocks(content, targetChars) {
  const blocks = []
  const headingStack = []
  let paragraph = []
  let paragraphHeading = ""

  const currentHeadingPath = () => headingStack.filter(Boolean).join(" > ")
  const flushParagraph = () => {
    const text = paragraph.join("\n").trim()
    if (text) {
      for (const piece of splitOversizedBlock(text, targetChars)) {
        blocks.push({ text: piece, headingPath: paragraphHeading })
      }
    }
    paragraph = []
  }

  for (const line of content.replace(/\r\n/g, "\n").split("\n")) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (heading) {
      flushParagraph()
      const depth = heading[1].length
      headingStack.length = depth - 1
      headingStack[depth - 1] = heading[2].trim()
      blocks.push({ text: line.trim(), headingPath: currentHeadingPath() })
      paragraphHeading = currentHeadingPath()
      continue
    }

    if (line.trim() === "") {
      flushParagraph()
      paragraphHeading = currentHeadingPath()
      continue
    }

    if (paragraph.length === 0) paragraphHeading = currentHeadingPath()
    paragraph.push(line)
  }
  flushParagraph()

  return blocks
}

function overlapSuffix(text, maxChars) {
  if (!text || maxChars <= 0) return ""
  if (text.length <= maxChars) return text
  const raw = text.slice(-maxChars)
  const paragraphBreak = raw.search(/\n\s*\n/)
  if (paragraphBreak > 0 && raw.length - paragraphBreak > maxChars * 0.4) {
    return raw.slice(paragraphBreak).trim()
  }
  const sentenceBreak = raw.search(/[.!?。！？]\s+/)
  if (sentenceBreak > 0 && raw.length - sentenceBreak > maxChars * 0.4) {
    return raw.slice(sentenceBreak + 1).trim()
  }
  return raw.trim()
}

export function splitSourceIntoSemanticChunks(content, targetChars, overlapChars) {
  const target = Math.max(1_000, targetChars)
  const blocks = semanticBlocks(content, target)
  if (blocks.length === 0) return []

  const rawChunks = []
  let current = []
  let currentLength = 0
  let currentHeading = blocks[0]?.headingPath ?? ""

  const flush = () => {
    const main = current.join("\n\n").trim()
    if (main) rawChunks.push({ main, headingPath: currentHeading })
    current = []
    currentLength = 0
  }

  for (const block of blocks) {
    const nextLength = currentLength + block.text.length + (current.length > 0 ? 2 : 0)
    if (current.length > 0 && nextLength > target) {
      flush()
    }
    if (current.length === 0) currentHeading = block.headingPath
    current.push(block.text)
    currentLength += block.text.length + (current.length > 1 ? 2 : 0)
  }
  flush()

  return rawChunks.map((chunk, idx) => ({
    id: `chunk-${idx + 1}`,
    index: idx + 1,
    total: rawChunks.length,
    headingPath: chunk.headingPath,
    overlapBefore: idx > 0 ? overlapSuffix(rawChunks[idx - 1].main, overlapChars) : "",
    main: chunk.main,
  }))
}

export function hashTextHex(text) {
  // 64-bit FNV-1a over UTF-16 code units. This is a stability key, not
  // a security primitive; validation also checks source length/chunk
  // shape before resuming a checkpoint.
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i))
    hash = BigInt.asUintN(64, hash * prime)
  }
  return hash.toString(16).padStart(16, "0")
}

export function longSourceCheckpointPath(projectPath, sourceSummarySlug, sourceHash) {
  return `${normalizePath(projectPath)}/.llm-wiki/ingest-progress/${sourceSummarySlug}-${sourceHash}.json`
}

export function isCompatibleLongSourceCheckpoint(checkpoint, params) {
  return checkpoint.version === 1
    && checkpoint.sourceIdentity === params.sourceIdentity
    && checkpoint.sourceHash === params.sourceHash
    && checkpoint.sourceLength === params.sourceLength
    && checkpoint.sourceBudget === params.sourceBudget
    && checkpoint.targetChars === params.targetChars
    && checkpoint.overlapChars === params.overlapChars
    && checkpoint.chunkTotal === params.chunkTotal
    && checkpoint.completedThrough >= 0
    && checkpoint.completedThrough <= params.chunkTotal
    && Array.isArray(checkpoint.analyses)
    && checkpoint.analyses.length === checkpoint.completedThrough
}

export async function loadLongSourceCheckpoint(checkpointPath, params) {
  try {
    const raw = await fsReadFile(checkpointPath, "utf8")
    const parsed = JSON.parse(raw)
    if (!isCompatibleLongSourceCheckpoint(parsed, params)) return null
    return parsed
  } catch {
    return null
  }
}

export async function saveLongSourceCheckpoint(checkpointPath, checkpoint) {
  const dir = checkpointPath.split("/").slice(0, -1).join("/")
  await mkdir(dir, { recursive: true })
  await fsWriteFile(checkpointPath, JSON.stringify(checkpoint, null, 2))
}

export async function clearLongSourceCheckpoint(checkpointPath) {
  try {
    if (await fileExists(checkpointPath)) {
      await rm(checkpointPath)
    }
  } catch {
    // Best-effort cleanup. A stale checkpoint is ignored if source
    // hash / chunk shape no longer matches.
  }
}

async function fileExists(fullPath) {
  try {
    await stat(fullPath)
    return true
  } catch {
    return false
  }
}
