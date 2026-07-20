export interface StructuralLintPage {
  shortName: string
  slug: string
  title: string
  outlinks: string[]
  tokens: string[]
}

export interface StructuralLintFinding {
  type: "orphan" | "broken-link" | "no-outlinks"
  severity: "warning" | "info"
  page: string
  detail: string
  brokenTarget?: string
  suggestedTarget?: string
  suggestedSource?: string
}

interface IndexedPage extends StructuralLintPage {
  tokenSet: Set<string>
}

const BROKEN_LINK_SUGGESTION_MIN_SCORE = 0.74
const RELATED_PAGE_SUGGESTION_MIN_SCORE = 0.08
const SAME_FOLDER_SCORE_BONUS = 0.08
const SINGLE_CJK_TOKEN_WEIGHT = 0.35
const SAME_BASENAME_SCORE = 0.96
const CONTAINS_TARGET_SCORE = 0.82
const MAX_SUGGESTION_CANDIDATES = 64

function fileName(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() ?? path
}

function normalizeTarget(target: string): string {
  return target.replace(/\\/g, "/")
    .replace(/^wiki\//i, "")
    .replace(/\.md$/i, "")
    .trim()
    .toLowerCase()
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a) return b.length
  if (!b) return a.length
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  const current = new Array<number>(b.length + 1)
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost)
    }
    for (let j = 0; j <= b.length; j += 1) previous[j] = current[j]
  }
  return previous[b.length]
}

function stringSimilarity(a: string, b: string): number {
  const left = normalizeTarget(a)
  const right = normalizeTarget(b)
  if (!left || !right) return 0
  if (left === right) return 1
  const leftBase = fileName(left)
  const rightBase = fileName(right)
  if (leftBase === rightBase) return SAME_BASENAME_SCORE
  if (right.includes(left) || left.includes(right)) return CONTAINS_TARGET_SCORE
  if (leftBase.length < 5 || rightBase.length < 5) return 0
  return 1 - levenshtein(leftBase, rightBase) / Math.max(leftBase.length, rightBase.length)
}

function fragments(value: string): string[] {
  const normalized = normalizeTarget(value).normalize("NFKC")
  const chars = Array.from(normalized)
  if (chars.length < 2) return normalized ? [normalized] : []
  const result = new Set<string>()
  for (let i = 0; i < chars.length - 1; i += 1) result.add(`${chars[i]}${chars[i + 1]}`)
  return Array.from(result)
}

function addToIndex(index: Map<string, number[]>, key: string, pageIndex: number): void {
  const values = index.get(key)
  if (values) values.push(pageIndex)
  else index.set(key, [pageIndex])
}

function topCandidates(scores: Map<number, number>, excluded: number): number[] {
  return Array.from(scores.entries())
    .filter(([index]) => index !== excluded)
    .sort((left, right) => right[1] - left[1] || left[0] - right[0])
    .slice(0, MAX_SUGGESTION_CANDIDATES)
    .map(([index]) => index)
}

export function computeStructuralLint(
  rawPages: StructuralLintPage[],
  onProgress?: (completed: number, total: number) => void,
): StructuralLintFinding[] {
  const pages: IndexedPage[] = rawPages.map((page) => ({ ...page, tokenSet: new Set(page.tokens) }))
  const slugMap = new Map<string, number>()
  const tokenIndex = new Map<string, number[]>()
  const fragmentIndex = new Map<string, number[]>()

  pages.forEach((page, index) => {
    const basename = fileName(page.shortName).replace(/\.md$/i, "")
    slugMap.set(normalizeTarget(page.slug), index)
    slugMap.set(normalizeTarget(basename), index)
    for (const token of page.tokenSet) addToIndex(tokenIndex, token, index)
    for (const value of [page.slug, page.shortName, page.title]) {
      for (const fragment of fragments(value)) addToIndex(fragmentIndex, fragment, index)
    }
  })

  const inboundCounts = new Map<number, number>()
  for (const page of pages) {
    for (const link of page.outlinks) {
      const target = slugMap.get(normalizeTarget(link))
        ?? slugMap.get(normalizeTarget(fileName(link).replace(/\.md$/i, "")))
      if (target !== undefined) inboundCounts.set(target, (inboundCounts.get(target) ?? 0) + 1)
    }
  }

  function relatedCandidate(pageIndex: number, direction: "source" | "target"): IndexedPage | undefined {
    const page = pages[pageIndex]
    const scores = new Map<number, number>()
    for (const token of page.tokenSet) {
      const matches = tokenIndex.get(token) ?? []
      // Very common terms do not identify a useful related page and recreate
      // the quadratic scan this index is intended to avoid.
      if (matches.length > Math.max(20, Math.ceil(pages.length * 0.25))) continue
      const weight = token.length > 1 ? 1 : SINGLE_CJK_TOKEN_WEIGHT
      for (const candidate of matches) scores.set(candidate, (scores.get(candidate) ?? 0) + weight)
    }
    const existing = new Set(page.outlinks.map(normalizeTarget))
    let best: { page: IndexedPage; score: number } | undefined
    for (const candidateIndex of topCandidates(scores, pageIndex)) {
      const candidate = pages[candidateIndex]
      if (direction === "target") {
        const keys = [candidate.slug, candidate.shortName, fileName(candidate.shortName).replace(/\.md$/i, "")]
          .map(normalizeTarget)
        if (keys.some((key) => existing.has(key))) continue
      }
      const overlap = scores.get(candidateIndex) ?? 0
      const folderBonus = page.shortName.split("/")[0] === candidate.shortName.split("/")[0]
        ? SAME_FOLDER_SCORE_BONUS
        : 0
      const score = overlap / Math.sqrt(Math.max(1, page.tokenSet.size) * Math.max(1, candidate.tokenSet.size)) + folderBonus
      if (score > (best?.score ?? 0)) best = { page: candidate, score }
    }
    return best && best.score >= RELATED_PAGE_SUGGESTION_MIN_SCORE ? best.page : undefined
  }

  function brokenCandidate(target: string): IndexedPage | undefined {
    const scores = new Map<number, number>()
    for (const fragment of fragments(target)) {
      for (const candidate of fragmentIndex.get(fragment) ?? []) {
        scores.set(candidate, (scores.get(candidate) ?? 0) + 1)
      }
    }
    let best: { page: IndexedPage; score: number } | undefined
    for (const candidateIndex of topCandidates(scores, -1)) {
      const candidate = pages[candidateIndex]
      const score = Math.max(
        stringSimilarity(target, candidate.slug),
        stringSimilarity(target, candidate.shortName),
        stringSimilarity(target, candidate.title),
      )
      if (score > (best?.score ?? 0)) best = { page: candidate, score }
    }
    return best && best.score >= BROKEN_LINK_SUGGESTION_MIN_SCORE ? best.page : undefined
  }

  const results: StructuralLintFinding[] = []
  pages.forEach((page, pageIndex) => {
    if (!inboundCounts.has(pageIndex)) {
      results.push({
        type: "orphan",
        severity: "info",
        page: page.shortName,
        detail: "No other pages link to this page.",
        suggestedSource: relatedCandidate(pageIndex, "source")?.shortName,
      })
    }
    if (page.outlinks.length === 0) {
      results.push({
        type: "no-outlinks",
        severity: "info",
        page: page.shortName,
        detail: "This page has no [[wikilink]] references to other pages.",
        suggestedTarget: relatedCandidate(pageIndex, "target")?.shortName,
      })
    }
    for (const link of page.outlinks) {
      const basename = fileName(link).replace(/\.md$/i, "")
      if (slugMap.has(normalizeTarget(link)) || slugMap.has(normalizeTarget(basename))) continue
      results.push({
        type: "broken-link",
        severity: "warning",
        page: page.shortName,
        detail: `Broken link: [[${link}]] — target page not found.`,
        brokenTarget: link,
        suggestedTarget: brokenCandidate(link)?.shortName,
      })
    }
    if (pageIndex % 25 === 0 || pageIndex === pages.length - 1) {
      onProgress?.(pageIndex + 1, pages.length)
    }
  })
  return results
}
