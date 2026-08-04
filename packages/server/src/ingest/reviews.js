// Server port of the review pieces of src/lib/ingest.ts and
// src/stores/review-store.ts for the server-driven ingest pipeline
// (issue #14). Behavior is byte-identical to the client modules; only
// types were stripped. The zustand store's addItems merge semantics are
// ported as the pure function foldReviewItems (store reads → explicit
// parameters), and saveIngestReviewItems adds Node persistence on top
// (node:fs/promises instead of Tauri fs commands).
//
// normalizeReviewTitle comes from src/lib/review-utils.ts verbatim;
// it lives here because reviewIdFor depends on it and no separate
// server port of review-utils exists yet.
import { readFile, writeFile, mkdir, rename } from "node:fs/promises"
import path from "node:path"

// Common prefixes LLM may prepend in English or Chinese review titles.
// Kept in one place so dedupe and sweep agree on what "the same concept" means.
const REVIEW_TITLE_PREFIX_RE =
  /^(missing[\s-]?page[:：]\s*|duplicate[\s-]?page[:：]\s*|possible[\s-]?duplicate[:：]\s*|缺失页面[:：]\s*|缺少页面[:：]\s*|重复页面[:：]\s*|疑似重复[:：]\s*)/i

/**
 * Normalize a review title for equality comparison:
 *   - strip leading "Missing page:" / "缺失页面:" / etc.
 *   - collapse whitespace
 *   - lowercase
 *
 * Two review items with the same (type, normalized title) are considered
 * the same concept and should be merged rather than duplicated.
 */
export function normalizeReviewTitle(title) {
  return title
    .trimStart()
    .replace(REVIEW_TITLE_PREFIX_RE, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

export const REVIEW_BLOCK_REGEX = /---REVIEW:\s*(\w[\w-]*)\s*\|\s*(.+?)\s*---\n([\s\S]*?)---END REVIEW---/g

export function parseReviewBlocks(
  text,
  sourcePath,
) {
  const items = []
  const matches = text.matchAll(REVIEW_BLOCK_REGEX)

  for (const match of matches) {
    const rawType = match[1].trim().toLowerCase()
    const title = match[2].trim()
    const body = match[3].trim()

    const type = (
      ["contradiction", "duplicate", "missing-page", "suggestion"].includes(rawType)
        ? rawType
        : "confirm"
    )

    // Parse OPTIONS line
    const optionsMatch = body.match(/^OPTIONS:\s*(.+)$/m)
    const options = optionsMatch
      ? optionsMatch[1].split("|").map((o) => {
          const label = o.trim()
          return { label, action: label }
        })
      : [
          { label: "Approve", action: "Approve" },
          { label: "Skip", action: "Skip" },
        ]

    // Parse PAGES line
    const pagesMatch = body.match(/^PAGES:\s*(.+)$/m)
    const affectedPages = pagesMatch
      ? pagesMatch[1].split(",").map((p) => p.trim())
      : undefined

    // Parse SEARCH line (optimized search queries for Deep Research)
    const searchMatch = body.match(/^SEARCH:\s*(.+)$/m)
    const searchQueries = searchMatch
      ? searchMatch[1].split("|").map((q) => q.trim()).filter((q) => q.length > 0)
      : undefined

    // Description is the body minus OPTIONS, PAGES, and SEARCH lines
    const description = body
      .replace(/^OPTIONS:.*$/m, "")
      .replace(/^PAGES:.*$/m, "")
      .replace(/^SEARCH:.*$/m, "")
      .trim()

    items.push({
      type,
      title,
      description,
      sourcePath,
      affectedPages,
      searchQueries,
      options,
    })
  }

  return items
}

/**
 * Content-derived stable id. The SAME logical review (same type + same
 * normalized title) always gets the SAME id, so it survives ingest
 * regeneration, file moves, and reloads — and an external caller (the
 * resolve API) can target it reliably.
 *
 * Deliberately NOT counter-based (the old `review-N` scheme re-numbered
 * every review whenever the queue rebuilt, discarding resolved state)
 * and deliberately NOT keyed on sourcePath (mutable — a file rename
 * would re-id the review, the exact instability we're removing).
 *
 * "Collision" — two inputs sharing an id — is the intended behaviour:
 * identical content is the same review. Stability is bounded by
 * `normalizeReviewTitle` across LLM regenerations, the same ceiling the
 * previous dedup already accepted.
 */
export function reviewIdFor(item) {
  const key = `${item.type}::${normalizeReviewTitle(item.title)}`
  // FNV-1a (32-bit) — small, deterministic, dependency-free.
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `review-${(h >>> 0).toString(16).padStart(8, "0")}`
}

/** Union two optional string arrays, dropping the field when empty. */
function unionField(a, b) {
  const merged = Array.from(new Set([...(a ?? []), ...(b ?? [])]))
  return merged.length > 0 ? merged : undefined
}

function mergeOptions(a, b) {
  const byAction = new Map()
  for (const option of [...a, ...b]) {
    byAction.set(option.action, option)
  }
  return [...byAction.values()]
}

/**
 * Collapse two items that resolved to the same stable id. resolved
 * wins (if either was resolved, the survivor is), union the array
 * fields, keep the earliest createdAt, prefer a non-empty description.
 */
function mergeReviewItems(a, b) {
  const resolved = a.resolved || b.resolved
  const resolvedAction = resolved ? a.resolvedAction ?? b.resolvedAction : undefined
  return {
    ...a, // a.id is kept; both share it by construction
    resolved,
    resolvedAction,
    description: a.description || b.description,
    sourcePath: a.sourcePath ?? b.sourcePath,
    affectedPages: unionField(a.affectedPages, b.affectedPages),
    searchQueries: unionField(a.searchQueries, b.searchQueries),
    options: mergeOptions(a.options, b.options),
    createdAt: Math.min(a.createdAt, b.createdAt),
  }
}

export function normalizeReviewItems(items) {
  const byId = new Map()
  for (const raw of items) {
    const remapped = { ...raw, id: reviewIdFor(raw) }
    const existing = byId.get(remapped.id)
    byId.set(remapped.id, existing ? mergeReviewItems(existing, remapped) : remapped)
  }
  return [...byId.values()]
}

/**
 * Pure port of the review store's addItems merge semantics. Dedup on
 * the content-stable id against ALL existing items — including resolved
 * ones. The previous scheme only deduped against *pending* items, which
 * is exactly why re-surfacing a review during ingest discarded its
 * resolved state. Now a resolved review with the same content is
 * preserved (resolved wins), with array fields merged.
 *
 * Genuinely-new items get their stable id, resolved=false and
 * createdAt=Date.now() assigned here.
 */
export function foldReviewItems(existingItems, incomingItems) {
  const result = [...existingItems]
  const indexById = new Map()
  result.forEach((it, idx) => indexById.set(it.id, idx))

  for (const incoming of incomingItems) {
    const id = reviewIdFor(incoming)
    const existingIdx = indexById.get(id)

    if (existingIdx !== undefined) {
      const old = result[existingIdx]
      result[existingIdx] = {
        ...old, // preserves resolved / resolvedAction / createdAt / id
        description: incoming.description || old.description,
        sourcePath: incoming.sourcePath ?? old.sourcePath,
        affectedPages: unionField(old.affectedPages, incoming.affectedPages),
        searchQueries: unionField(old.searchQueries, incoming.searchQueries),
      }
    } else {
      result.push({ ...incoming, id, resolved: false, createdAt: Date.now() })
      indexById.set(id, result.length - 1)
    }
  }

  return result
}

/**
 * Server persistence for ingest review items. Reads
 * `<projectPath>/.llm-wiki/review.json` if present (normalizing it —
 * the migrate-on-load remap folds old counter ids into content-stable
 * ones, resolved wins), folds `parsedItems` (parseReviewBlocks output)
 * in with foldReviewItems semantics, and writes back atomically
 * (tmp file + rename). The on-disk shape is the ReviewItem[] array
 * that packages/server/src/api/reviews.js (and api-v1.js loadReviews)
 * reads, serialized exactly like the client's persist.ts
 * (JSON.stringify(items, null, 2)).
 *
 * Returns the merged item list that was persisted.
 */
export async function saveIngestReviewItems(projectPath, parsedItems) {
  const dir = path.join(projectPath, ".llm-wiki")
  const target = path.join(dir, "review.json")

  let existing = []
  try {
    const content = await readFile(target, "utf8")
    const parsed = JSON.parse(content)
    if (Array.isArray(parsed)) existing = normalizeReviewItems(parsed)
  } catch {
    existing = []
  }

  const merged = foldReviewItems(existing, parsedItems)

  await mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `.review.json.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`)
  await writeFile(tmp, JSON.stringify(merged, null, 2), "utf8")
  await rename(tmp, target)

  return merged
}
