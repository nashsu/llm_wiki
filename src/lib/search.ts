import { readFile, listDirectory } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"
import { normalizePath, getFileStem } from "@/lib/path-utils"
import { parseFrontmatter } from "@/lib/frontmatter"
import {
  scalarFrontmatterValue,
  shouldExcludeFromDefaultKnowledgeSurface,
} from "@/lib/wiki-metadata"

/**
 * One image reference extracted from a matched page's markdown.
 *
 * `url` is verbatim what was inside the `![](...)` parens — this is
 * a forward-slash path that the markdown image resolver knows how
 * to map to a renderable URL. We deliberately keep it pre-resolution
 * so the search-result UI can filter by URL prefix (e.g. "only show
 * images from this source's media dir") before paying the cost of
 * `convertFileSrc`.
 */
export interface ImageRef {
  url: string
  alt: string
}

export interface SearchResult {
  path: string
  title: string
  snippet: string
  titleMatch: boolean
  score: number
  /**
   * Image references found inside this result's markdown. Populated
   * even when the query doesn't match the alt text — the UI splits
   * "alt-matches-query" from "image just lives on this matched
   * page" itself, so both views need the full set. May be empty.
   */
  images: ImageRef[]
}

const MAX_RESULTS = 20
const SNIPPET_CONTEXT = 80

// ── Reciprocal Rank Fusion ─────────────────────────────────────────────────
// Token search and vector search produce two independently-ranked lists.
// Their absolute scores are incommensurable (token score: 1-400, vector
// cosine: 0-1), so summing them privileges whichever list happens to use
// the larger numbers. RRF sidesteps that by fusing on RANK only:
//
//     fused(p) = sum over lists L of  1 / (K + rank_L(p))
//
// A page that ranks #1 in BOTH lists wins handily. A page that's only in
// one list still surfaces if it ranks high there, but a page in BOTH a
// little lower can outrank it — exactly what we want for hybrid retrieval.
//
// K=60 is the canonical constant from Cormack et al. (SIGIR 2009), large
// enough that small rank differences near the top don't dominate but
// small enough that being deep in either list still falls off quickly.
const RRF_K = 60

// ── Scoring weights ────────────────────────────────────────────────────────
// Exact lexical matches dominate everything else. The rationale: when a
// user types "attention", the page literally named `attention.md` MUST
// rank first, regardless of how many other pages also mention the word.
//
//   filename == query (e.g. `attention.md` for query "attention")
//     → FILENAME_EXACT_BONUS — large enough that nothing short of an
//       equally-exact match can outrank it.
//
//   title or content contains the raw query as a substring
//     → PHRASE_IN_TITLE_BONUS / PHRASE_IN_CONTENT_PER_OCC — phrase
//       presence is worth far more than individual token presence, and
//       in content it rewards repetition (with a cap to avoid runaway).
//
//   per-token matches (existing behavior, but now smaller weight)
//     → TITLE_TOKEN_WEIGHT / CONTENT_TOKEN_WEIGHT. These used to
//       dominate via a flat +10 title bonus regardless of how many
//       tokens matched; now each matched token counts individually.
const FILENAME_EXACT_BONUS = 200
const PHRASE_IN_TITLE_BONUS = 50
const PHRASE_IN_CONTENT_PER_OCC = 20
const MAX_PHRASE_OCC_COUNTED = 10 // cap to avoid runaway on huge logs
const TITLE_TOKEN_WEIGHT = 5
const CONTENT_TOKEN_WEIGHT = 1

const STOP_WORDS = new Set([
  "的", "是", "了", "什么", "在", "有", "和", "与", "对", "从",
  "the", "is", "a", "an", "what", "how", "are", "was", "were",
  "do", "does", "did", "be", "been", "being", "have", "has", "had",
  "it", "its", "in", "on", "at", "to", "for", "of", "with", "by",
  "this", "that", "these", "those",
])

export function tokenizeQuery(query: string): string[] {
  // Split by whitespace and punctuation
  const rawTokens = query
    .toLowerCase()
    .split(/[\s,，。！？、；：""''（）()\-_/\\·~～…]+/)
    .filter((t) => t.length > 1)
    .filter((t) => !STOP_WORDS.has(t))

  const tokens: string[] = []

  for (const token of rawTokens) {
    // Check if token contains CJK characters
    const hasCJK = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(token)

    if (hasCJK && token.length > 2) {
      // For CJK text: split into individual characters AND overlapping bigrams
      // "默会知识" → ["默会", "会知", "知识", "默", "会", "知", "识"]
      const chars = [...token]
      // Add bigrams (most useful for Chinese)
      for (let i = 0; i < chars.length - 1; i++) {
        tokens.push(chars[i] + chars[i + 1])
      }
      // Also add individual chars (for single-char matches)
      for (const ch of chars) {
        if (!STOP_WORDS.has(ch)) {
          tokens.push(ch)
        }
      }
      // Keep the original token too (for exact phrase match)
      tokens.push(token)
    } else {
      tokens.push(token)
    }
  }

  // Deduplicate
  return [...new Set(tokens)]
}

function tokenMatchScore(text: string, tokens: readonly string[]): number {
  const lower = text.toLowerCase()
  let score = 0
  for (const token of tokens) {
    if (lower.includes(token)) score += 1
  }
  return score
}

function countOccurrences(haystackLower: string, needleLower: string): number {
  if (!needleLower || needleLower.length === 0) return 0
  let count = 0
  let pos = 0
  while (true) {
    const idx = haystackLower.indexOf(needleLower, pos)
    if (idx === -1) break
    count++
    pos = idx + needleLower.length
  }
  return count
}

function flattenMdFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenMdFiles(node.children))
    } else if (!node.is_dir && node.name.endsWith(".md")) {
      files.push(node)
    }
  }
  return files
}

function extractTitle(content: string, fileName: string): string {
  // Try YAML frontmatter title
  const frontmatterMatch = content.match(/^---\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m)
  if (frontmatterMatch) return frontmatterMatch[1].trim()

  // Try first heading
  const headingMatch = content.match(/^#\s+(.+)$/m)
  if (headingMatch) return headingMatch[1].trim()

  // Fall back to filename
  return fileName.replace(/\.md$/, "").replace(/-/g, " ")
}

/**
 * Markdown image-reference regex. Matches `![alt](url)` capturing
 * groups 1=alt, 2=url. Identical to the regex in
 * `image-caption-pipeline.ts` — kept duplicated rather than shared
 * because the two modules have very different lifetimes (search
 * runs every keystroke; the pipeline runs at ingest), and a shared
 * symbol there would tie them together for no benefit.
 *
 * Excludes:
 *   - HTML `<img src=...>` (we don't generate these)
 *   - Reference-style `![alt][ref]` (we don't generate these either)
 */
const IMAGE_REF_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g

function extractImageRefs(content: string): ImageRef[] {
  const seen = new Set<string>()
  const out: ImageRef[] = []
  for (const m of content.matchAll(IMAGE_REF_RE)) {
    const url = m[2]
    // De-dupe within a single page: the same image may be
    // referenced both inline (LLM-preserved) AND in the safety-net
    // "## Embedded Images" section. Showing it twice in the
    // results UI would just be visual noise.
    if (seen.has(url)) continue
    seen.add(url)
    out.push({ url, alt: m[1] })
  }
  return out
}

function buildSnippet(content: string, query: string): string {
  const lower = content.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const idx = lower.indexOf(lowerQuery)
  if (idx === -1) return content.slice(0, SNIPPET_CONTEXT * 2).replace(/\n/g, " ")

  const start = Math.max(0, idx - SNIPPET_CONTEXT)
  const end = Math.min(content.length, idx + query.length + SNIPPET_CONTEXT)
  let snippet = content.slice(start, end).replace(/\n/g, " ")
  if (start > 0) snippet = "..." + snippet
  if (end < content.length) snippet = snippet + "..."
  return snippet
}

export async function searchWiki(
  projectPath: string,
  query: string,
): Promise<SearchResult[]> {
  if (!query.trim()) return []
  const pp = normalizePath(projectPath)

  const tokens = tokenizeQuery(query)
  // Fallback: if all tokens were filtered out, use the trimmed query as a single token
  const effectiveTokens = tokens.length > 0 ? tokens : [query.trim().toLowerCase()]
  const results: SearchResult[] = []

  // Search wiki pages.
  //
  // We deliberately do NOT also search `raw/sources/` here anymore.
  // Previously this section walked every file under raw/sources/
  // (including PDFs / DOCX / PPTX) and called `readFile` on each,
  // which triggers the heavy pdfium / office text-extraction path
  // — even on cache hits, that's an IPC round-trip per file plus
  // a cache file read of the now-large combined-markdown output
  // (text + per-page image refs after the unified extractor
  // landed). On a project with ~50 PDFs this added 5-15s per
  // search, which the user reported as "very, very slow."
  //
  // The content lost: nothing material. Each ingested raw source
  // produces a `wiki/sources/<slug>.md` summary which is included
  // in the wiki/ search below; the full extracted text lives in
  // the embedding chunks and is reachable via vector search. The
  // raw-files token pass added recall only for raw files that had
  // never been ingested (and thus had no wiki summary), which is
  // not a workflow we want to optimize at the cost of every other
  // search call.
  try {
    const t0 = performance.now()
    const wikiTree = await listDirectory(`${pp}/wiki`)
    const wikiFiles = flattenMdFiles(wikiTree)
    const tList = Math.round(performance.now() - t0)
    const t1 = performance.now()
    await searchFiles(wikiFiles, effectiveTokens, query, results)
    const tRead = Math.round(performance.now() - t1)
    console.log(
      `[Search:token] wiki/ ${wikiFiles.length} files | list=${tList}ms read+match=${tRead}ms`,
    )
  } catch {
    // no wiki directory
  }

  // ── Build the token-side ranking (still based on the score field
  // populated by searchFiles above). Snapshot it BEFORE the vector
  // step, so adding vector-only pages doesn't shift token ranks.
  const tokenSorted = [...results].sort((a, b) => b.score - a.score)
  const tokenRank = new Map<string, number>()
  tokenSorted.forEach((r, i) => {
    tokenRank.set(normalizePath(r.path), i + 1) // 1-indexed
  })

  // ── Vector search: collect ranked list of page-ids and materialize
  //    pages that token search missed. We do NOT add to results' score
  //    here — that's done in the RRF step below.
  let vectorRank = new Map<string, number>()
  let vectorCount = 0
  try {
    const { useWikiStore } = await import("@/stores/wiki-store")
    const embCfg = useWikiStore.getState().embeddingConfig
    console.log(`[Vector Search] Config: enabled=${embCfg.enabled}, model="${embCfg.model}"`)
    if (embCfg.enabled && embCfg.model) {
      const t0 = performance.now()
      const { searchByEmbedding } = await import("@/lib/embedding")
      const vectorResults = await searchByEmbedding(pp, query, embCfg, 10)
      const vectorMs = Math.round(performance.now() - t0)
      vectorCount = vectorResults.length

      console.log(
        `[Vector Search] query="${query}" | ${vectorResults.length} results in ${vectorMs}ms | model=${embCfg.model}` +
        (vectorResults.length > 0
          ? ` | top: ${vectorResults.slice(0, 5).map((r) => `${r.id}(${r.score.toFixed(3)})`).join(", ")}`
          : "")
      )

      // Build vectorRank by page_id (slug); searchByEmbedding returns
      // results pre-sorted by descending similarity.
      vectorResults.forEach((vr, i) => vectorRank.set(vr.id, i + 1))

      // Materialize any vector-result page that token search didn't
      // already include — without this, `results` has no entry for
      // them and they can't surface even with a top vector rank.
      const knownIds = new Set(results.map((r) => getFileStem(r.path)))
      let added = 0
      for (const vr of vectorResults) {
        if (knownIds.has(vr.id)) continue
        const dirs = ["entities", "concepts", "sources", "comparisons", "synthesis", "queries", "decisions", "comparison"]
        for (const dir of dirs) {
          const tryPath = `${pp}/wiki/${dir}/${vr.id}.md`
          try {
            const content = await readFile(tryPath)
            if (isSearchExcludedFile({ path: tryPath }, content)) {
              continue
            }
            const title = extractTitle(content, `${vr.id}.md`)
            results.push({
              path: tryPath,
              title,
              snippet: buildSnippet(content, query),
              titleMatch: false,
              score: 0, // overwritten by RRF below
              images: extractImageRefs(content),
            })
            knownIds.add(vr.id)
            added++
            break
          } catch {
            // not in this directory
          }
        }
      }
      if (added > 0) {
        console.log(`[Vector Search] Added ${added} vector-only pages to candidate set`)
      }
    }
  } catch (err) {
    console.log(`[Vector Search] Skipped: ${err instanceof Error ? err.message : "not available"}`)
    vectorRank = new Map()
  }

  // ── RRF fusion: replace each result's score with
  //   1/(K + token_rank) + 1/(K + vector_rank)
  //
  // Pages absent from either list contribute 0 from that side.
  // Pages absent from BOTH never make it here (we only iterate the
  // results array, which already contains every candidate).
  for (const r of results) {
    const tRank = tokenRank.get(normalizePath(r.path))
    const vRank = vectorRank.get(getFileStem(r.path))
    let rrf = 0
    if (tRank !== undefined) rrf += 1 / (RRF_K + tRank)
    if (vRank !== undefined) rrf += 1 / (RRF_K + vRank)
    r.score = rrf
  }

  // Sort by RRF score descending. Ties (e.g. two pages both at vector
  // rank 1 but neither in token list) are broken by alphabetical path
  // order so output is deterministic for tests.
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return a.path.localeCompare(b.path)
  })

  const tokenHits = tokenRank.size
  console.log(
    `[Search] query="${query}" | RRF fused: ${tokenHits} token + ${vectorCount} vector → ${results.length} unique`,
  )

  return results.slice(0, MAX_RESULTS)
}

/**
 * Bound on concurrent `readFile` calls during search. Going wider
 * than this saturates the Tauri IPC channel and starts QUEUING
 * work behind the search request — the wider you go, the SLOWER
 * a single search gets past about 16-32 in-flight reads (measured
 * in dev against a 200-file project). 16 is a comfortable middle
 * ground that gives near-linear speedup over sequential without
 * choking the IPC layer.
 */
const SEARCH_READ_CONCURRENCY = 16

/**
 * Punctuation pattern shared between token splitting and the
 * phrase-bonus normalization below. Matched at start AND end of
 * the query — internal punctuation (`U.S.A.`, `2024-Q3`) stays
 * because it might be load-bearing in legitimate phrase matches.
 */
const TRIM_PUNCT_RE =
  /^[\s,，。！？、；：""''（）()\-_/\\·~～…]+|[\s,，。！？、；：""''（）()\-_/\\·~～…]+$/g

async function searchFiles(
  files: FileNode[],
  tokens: readonly string[],
  query: string,
  results: SearchResult[],
): Promise<void> {
  // Strip leading / trailing punctuation from the query before using
  // it as a phrase-bonus probe. Without this, `query="总资产。"`
  // tries to substring-match `总资产。` inside titles / content that
  // never have the period at that spot — the phrase-bonus signal
  // (worth +50 in titles, +20 per occurrence in content) silently
  // goes to zero and the page's RRF rank slides. Same surface that
  // bit the search-view image filter, fixed there in token space;
  // here we apply the analog in phrase space.
  //
  // Internal punctuation is preserved on purpose: queries like
  // "2024-Q3" or domain names should still phrase-match exactly.
  const queryPhrase = query.trim().toLowerCase().replace(TRIM_PUNCT_RE, "")

  // Process files in fixed-size concurrent batches. Promise.all over
  // the entire list would work but spawns N IPC calls simultaneously
  // — tested at N=200, that's where we saw the slowdown above.
  for (let i = 0; i < files.length; i += SEARCH_READ_CONCURRENCY) {
    const batch = files.slice(i, i + SEARCH_READ_CONCURRENCY)
    const batchResults = await Promise.all(
      batch.map(async (file) => {
        let content: string
        try {
          content = await readFile(file.path)
        } catch {
          return null
        }
        return scoreFile(file, content, tokens, queryPhrase, query)
      }),
    )
    for (const r of batchResults) {
      if (r) results.push(r)
    }
  }
}

/**
 * Pure scoring pass — no IO. Extracted so `searchFiles` can run
 * the IO and the matching independently and so this function can
 * be unit-tested without mocking readFile.
 */
function scoreFile(
  file: FileNode,
  content: string,
  tokens: readonly string[],
  queryPhrase: string,
  query: string,
): SearchResult | null {
  if (isSearchExcludedFile(file, content)) return null

  const title = extractTitle(content, file.name)
  const titleText = `${title} ${file.name}`
  const titleLower = titleText.toLowerCase()
  const contentLower = content.toLowerCase()
  const fileStem = file.name.replace(/\.md$/, "").toLowerCase()

  // Exact-match signals (strongest)
  const filenameExact = fileStem === queryPhrase
  const titleHasPhrase =
    queryPhrase.length > 0 && titleLower.includes(queryPhrase)
  const contentPhraseOcc = Math.min(
    countOccurrences(contentLower, queryPhrase),
    MAX_PHRASE_OCC_COUNTED,
  )

  // Token-level signals (fallback / density)
  const titleTokenScore = tokenMatchScore(titleText, tokens)
  const contentTokenScore = tokenMatchScore(content, tokens)

  if (
    !filenameExact &&
    !titleHasPhrase &&
    contentPhraseOcc === 0 &&
    titleTokenScore === 0 &&
    contentTokenScore === 0
  ) {
    return null
  }

  const score =
    (filenameExact ? FILENAME_EXACT_BONUS : 0) +
    (titleHasPhrase ? PHRASE_IN_TITLE_BONUS : 0) +
    contentPhraseOcc * PHRASE_IN_CONTENT_PER_OCC +
    titleTokenScore * TITLE_TOKEN_WEIGHT +
    contentTokenScore * CONTENT_TOKEN_WEIGHT

  const isTitleMatch = titleTokenScore > 0 || titleHasPhrase

  const snippetAnchor =
    contentPhraseOcc > 0
      ? queryPhrase
      : tokens.find((t) => contentLower.includes(t)) ?? query

  return {
    path: file.path,
    title,
    snippet: buildSnippet(content, snippetAnchor),
    titleMatch: isTitleMatch,
    score,
    images: extractImageRefs(content),
  }
}

function isSearchExcludedFile(file: Pick<FileNode, "path">, content: string): boolean {
  const frontmatter = parseFrontmatter(content).frontmatter
  if (!frontmatter) return false
  return shouldExcludeFromDefaultKnowledgeSurface({
    path: file.path,
    type: scalarFrontmatterValue(frontmatter.type),
    state: scalarFrontmatterValue(frontmatter.state),
    retention: scalarFrontmatterValue(frontmatter.retention),
  })
}
