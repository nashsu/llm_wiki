import { readFile, listDirectory } from "../shims/fs-node"
import type { FileNode } from "../types/wiki"
import { normalizePath, getFileStem } from "./path-utils"

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
  images: ImageRef[]
}

const MAX_RESULTS = 20
const SNIPPET_CONTEXT = 80
const RRF_K = 60
const FILENAME_EXACT_BONUS = 200
const PHRASE_IN_TITLE_BONUS = 50
const PHRASE_IN_CONTENT_PER_OCC = 20
const MAX_PHRASE_OCC_COUNTED = 10
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
  const rawTokens = query
    .toLowerCase()
    .split(/[\s,，。！？、；：""''（）()\-_/\\·~～…]+/)
    .filter((t) => t.length > 1)
    .filter((t) => !STOP_WORDS.has(t))

  const tokens: string[] = []
  for (const token of rawTokens) {
    const hasCJK = /[\u4e00-\u9fff\u3400-\u4dbf]/.test(token)
    if (hasCJK && token.length > 2) {
      const chars = [...token]
      for (let i = 0; i < chars.length - 1; i++) tokens.push(chars[i] + chars[i + 1])
      for (const ch of chars) { if (!STOP_WORDS.has(ch)) tokens.push(ch) }
      tokens.push(token)
    } else {
      tokens.push(token)
    }
  }
  return [...new Set(tokens)]
}

function tokenMatchScore(text: string, tokens: readonly string[]): number {
  const lower = text.toLowerCase()
  let score = 0
  for (const token of tokens) { if (lower.includes(token)) score += 1 }
  return score
}

function countOccurrences(haystackLower: string, needleLower: string): number {
  if (!needleLower) return 0
  let count = 0; let pos = 0
  while (true) {
    const idx = haystackLower.indexOf(needleLower, pos)
    if (idx === -1) break
    count++; pos = idx + needleLower.length
  }
  return count
}

function flattenMdFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) files.push(...flattenMdFiles(node.children))
    else if (!node.is_dir && node.name.endsWith(".md")) files.push(node)
  }
  return files
}

function extractTitle(content: string, fileName: string): string {
  const fm = content.match(/^---\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m)
  if (fm) return fm[1].trim()
  const h = content.match(/^#\s+(.+)$/m)
  if (h) return h[1].trim()
  return fileName.replace(/\.md$/, "").replace(/-/g, " ")
}

const IMAGE_REF_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g

function extractImageRefs(content: string): ImageRef[] {
  const seen = new Set<string>(); const out: ImageRef[] = []
  for (const m of content.matchAll(IMAGE_REF_RE)) {
    const url = m[2]
    if (seen.has(url)) continue
    seen.add(url); out.push({ url, alt: m[1] })
  }
  return out
}

function buildSnippet(content: string, query: string): string {
  const lower = content.toLowerCase(); const lowerQuery = query.toLowerCase()
  const idx = lower.indexOf(lowerQuery)
  if (idx === -1) return content.slice(0, SNIPPET_CONTEXT * 2).replace(/\n/g, " ")
  const start = Math.max(0, idx - SNIPPET_CONTEXT)
  const end = Math.min(content.length, idx + query.length + SNIPPET_CONTEXT)
  let snippet = content.slice(start, end).replace(/\n/g, " ")
  if (start > 0) snippet = "..." + snippet
  if (end < content.length) snippet = snippet + "..."
  return snippet
}

const TRIM_PUNCT_RE = /^[\s,，。！？、；：""''（）()\-_/\\·~～…]+|[\s,，。！？、；：""''（）()\-_/\\·~～…]+$/g
const SEARCH_READ_CONCURRENCY = 16

function scoreFile(
  file: FileNode, content: string, tokens: readonly string[], queryPhrase: string, query: string,
): SearchResult | null {
  const title = extractTitle(content, file.name)
  const titleText = `${title} ${file.name}`
  const titleLower = titleText.toLowerCase()
  const contentLower = content.toLowerCase()
  const fileStem = file.name.replace(/\.md$/, "").toLowerCase()

  const filenameExact = fileStem === queryPhrase
  const titleHasPhrase = queryPhrase.length > 0 && titleLower.includes(queryPhrase)
  const contentPhraseOcc = Math.min(countOccurrences(contentLower, queryPhrase), MAX_PHRASE_OCC_COUNTED)
  const titleTokenScore = tokenMatchScore(titleText, tokens)
  const contentTokenScore = tokenMatchScore(content, tokens)

  if (!filenameExact && !titleHasPhrase && contentPhraseOcc === 0 && titleTokenScore === 0 && contentTokenScore === 0) return null

  const score =
    (filenameExact ? FILENAME_EXACT_BONUS : 0) +
    (titleHasPhrase ? PHRASE_IN_TITLE_BONUS : 0) +
    contentPhraseOcc * PHRASE_IN_CONTENT_PER_OCC +
    titleTokenScore * TITLE_TOKEN_WEIGHT +
    contentTokenScore * CONTENT_TOKEN_WEIGHT

  const snippetAnchor = contentPhraseOcc > 0 ? queryPhrase : (tokens.find((t) => contentLower.includes(t)) ?? query)
  return {
    path: file.path, title, snippet: buildSnippet(content, snippetAnchor),
    titleMatch: titleTokenScore > 0 || titleHasPhrase, score, images: extractImageRefs(content),
  }
}

async function searchFiles(
  files: FileNode[], tokens: readonly string[], query: string, results: SearchResult[],
): Promise<void> {
  const queryPhrase = query.trim().toLowerCase().replace(TRIM_PUNCT_RE, "")
  for (let i = 0; i < files.length; i += SEARCH_READ_CONCURRENCY) {
    const batch = files.slice(i, i + SEARCH_READ_CONCURRENCY)
    const batchResults = await Promise.all(
      batch.map(async (file) => {
        let content: string
        try { content = await readFile(file.path) } catch { return null }
        return scoreFile(file, content, tokens, queryPhrase, query)
      }),
    )
    for (const r of batchResults) { if (r) results.push(r) }
  }
}

export async function searchWiki(projectPath: string, query: string): Promise<SearchResult[]> {
  if (!query.trim()) return []
  const pp = normalizePath(projectPath)
  const tokens = tokenizeQuery(query)
  const effectiveTokens = tokens.length > 0 ? tokens : [query.trim().toLowerCase()]
  const results: SearchResult[] = []

  try {
    const wikiTree = await listDirectory(`${pp}/wiki`)
    const wikiFiles = flattenMdFiles(wikiTree)
    await searchFiles(wikiFiles, effectiveTokens, query, results)
  } catch { /* no wiki directory */ }

  const tokenSorted = [...results].sort((a, b) => b.score - a.score)
  const tokenRank = new Map<string, number>()
  tokenSorted.forEach((r, i) => tokenRank.set(normalizePath(r.path), i + 1))

  // Vector search (optional — gracefully degrades when embedding not configured)
  let vectorRank = new Map<string, number>()
  let vectorCount = 0
  try {
    const { useWikiStore } = await import("../shims/stores-node")
    const embCfg = useWikiStore.getState().embeddingConfig
    if (embCfg.enabled && embCfg.model) {
      const { searchByEmbedding } = await import("../shims/embedding-stub")
      const vectorResults = await searchByEmbedding(pp, query, embCfg, 10)
      vectorCount = vectorResults.length
      vectorResults.forEach((vr, i) => vectorRank.set(vr.id, i + 1))

      const knownIds = new Set(results.map((r) => getFileStem(r.path)))
      for (const vr of vectorResults) {
        if (knownIds.has(vr.id)) continue
        const dirs = ["entities", "concepts", "sources", "synthesis", "comparison", "queries"]
        for (const dir of dirs) {
          const tryPath = `${pp}/wiki/${dir}/${vr.id}.md`
          try {
            const content = await readFile(tryPath)
            const title = extractTitle(content, `${vr.id}.md`)
            results.push({ path: tryPath, title, snippet: buildSnippet(content, query), titleMatch: false, score: 0, images: extractImageRefs(content) })
            knownIds.add(vr.id); break
          } catch { /* not in this dir */ }
        }
      }
    }
  } catch { /* vector search not available */ }

  // RRF fusion
  for (const r of results) {
    const tRank = tokenRank.get(normalizePath(r.path))
    const vRank = vectorRank.get(getFileStem(r.path))
    let rrf = 0
    if (tRank !== undefined) rrf += 1 / (RRF_K + tRank)
    if (vRank !== undefined) rrf += 1 / (RRF_K + vRank)
    r.score = rrf
  }

  results.sort((a, b) => b.score !== a.score ? b.score - a.score : a.path.localeCompare(b.path))
  console.error(`[search] "${query}" | token:${tokenRank.size} vector:${vectorCount} → ${results.length} results`)
  return results.slice(0, MAX_RESULTS)
}
