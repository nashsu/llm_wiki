import type {
  AutoLinkSuggestion,
  AutoLinkTargetCandidate,
  ConfidenceBand,
  IgnoreRules,
  LinkEntry,
  MatchKind,
  PageCatalogEntry,
} from "./auto-link-types"
import { isIgnoredPair, isIgnoredTerm } from "./auto-link-ignore"

const GENERIC_TERMS = new Set([
  "cell",
  "cells",
  "mechanism",
  "mechanisms",
  "pathway",
  "pathways",
  "gene",
  "genes",
  "protein",
  "proteins",
  "rna",
  "dna",
  "机制",
  "细胞",
  "通路",
  "表达",
  "反应",
])

const BAND_RANK: Record<ConfidenceBand, number> = {
  high: 0,
  medium: 1,
  low: 2,
}

const MATCH_RANK: Record<MatchKind, number> = {
  "slug-exact": 0,
  "title-exact": 1,
  "tag-exact": 2,
  "symbol-unique": 3,
  "cross-language-unique": 4,
  "ambiguous-strong": 5,
  "title-related": 6,
  partial: 7,
  "llm-preferred": 8,
}

interface ClassifiedMatch {
  candidate: AutoLinkTargetCandidate
  strong: boolean
}

function unwrapWikilink(value: string): string {
  const trimmed = value.trim()
  return trimmed.startsWith("[[") && trimmed.endsWith("]]")
    ? trimmed.slice(2, -2)
    : trimmed
}

export function normalizeForMatch(value: string): string {
  return unwrapWikilink(value)
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
}

export function isLikelySymbol(term: string): boolean {
  return /^[A-Z][A-Z0-9]{1,}$/.test(term.trim())
}

export function findCatalogMatches(
  term: string,
  catalog: PageCatalogEntry[],
): AutoLinkTargetCandidate[] {
  const normalizedTerm = normalizeForMatch(term)
  if (!normalizedTerm) return []

  const generic = GENERIC_TERMS.has(normalizedTerm)
  const symbol = isLikelySymbol(term)
  const literalTerm = unwrapWikilink(term).trim()
  const nonAscii = /[^\x00-\x7f]/.test(literalTerm)
  const normalizedLiteralTerm = literalTerm
    .normalize("NFKC")
    .toLowerCase()

  const matches = catalog.flatMap((entry): ClassifiedMatch[] => {
    const normalizedSlug = normalizeForMatch(entry.slug)
    const normalizedTitle = normalizeForMatch(entry.title)
    const normalizedTags = entry.tags.map(normalizeForMatch)
    const exactSlug = normalizedTerm === normalizedSlug
    const exactTitle = normalizedTerm === normalizedTitle
    const exactTag = normalizedTags.includes(normalizedTerm)
    const normalizedFields = [
      normalizedSlug,
      normalizedTitle,
      ...normalizedTags,
    ]
    const symbolMatch =
      symbol && normalizedFields.some((field) => field.includes(normalizedTerm))
    const crossLanguageMatch =
      nonAscii &&
      [entry.title, ...entry.tags].some((field) =>
        field
          .normalize("NFKC")
          .toLowerCase()
          .includes(normalizedLiteralTerm),
      )
    const meaningfulTitleTokens = normalizedTitle
      .split(" ")
      .filter((token) => token.length >= 4 && !GENERIC_TERMS.has(token))
    const titleRelated =
      normalizedTitle.includes(normalizedTerm) ||
      meaningfulTitleTokens.some((token) => normalizedTerm.includes(token))
    const slugPartial =
      normalizedSlug.includes(normalizedTerm) ||
      normalizedTerm.includes(normalizedSlug)

    if (
      !exactSlug &&
      !exactTitle &&
      !exactTag &&
      !symbolMatch &&
      !crossLanguageMatch &&
      !titleRelated &&
      !slugPartial
    ) {
      return []
    }

    let matchKind: MatchKind
    let reason: string
    if (exactSlug) {
      matchKind = "slug-exact"
      reason = "Exact normalized slug match."
    } else if (exactTitle) {
      matchKind = "title-exact"
      reason = "Exact normalized title match."
    } else if (exactTag) {
      matchKind = "tag-exact"
      reason = "Exact normalized tag match."
    } else if (!generic && symbolMatch) {
      matchKind = "symbol-unique"
      reason = "Unique symbol match."
    } else if (!generic && crossLanguageMatch) {
      matchKind = "cross-language-unique"
      reason = "Unique cross-language match."
    } else if (titleRelated || crossLanguageMatch) {
      matchKind = "title-related"
      reason = "Related title match."
    } else {
      matchKind = "partial"
      reason = "Partial normalized slug match."
    }

    const strong =
      exactSlug ||
      exactTitle ||
      exactTag ||
      (!generic && (symbolMatch || crossLanguageMatch))
    const band: ConfidenceBand = generic
      ? "low"
      : strong
        ? "high"
        : titleRelated
          ? "medium"
          : "low"

    return [
      {
        strong,
        candidate: {
          target: entry.slug,
          title: entry.title,
          path: entry.path,
          band,
          matchKind,
          reason: generic ? "Generic term; review manually." : reason,
        },
      },
    ]
  })

  const strongCount = matches.filter((match) => match.strong).length
  const candidates = matches.map(({ candidate, strong }) =>
    !generic && strong && strongCount >= 2
      ? {
          ...candidate,
          band: "medium" as const,
          matchKind: "ambiguous-strong" as const,
          reason: "Multiple strong catalog matches.",
        }
      : candidate,
  )

  return candidates.sort(compareCandidates)
}

export function buildAutoLinkSuggestions(
  rawLinks: LinkEntry[],
  catalog: PageCatalogEntry[],
  ignoreRules: IgnoreRules,
): AutoLinkSuggestion[] {
  const suggestions = rawLinks.flatMap((link): AutoLinkSuggestion[] => {
    if (isIgnoredTerm(link.term, ignoreRules)) return []

    const availableCatalog = catalog.filter(
      (entry) => !isIgnoredPair(link.term, entry.slug, ignoreRules),
    )
    const alternatives = findCatalogMatches(link.term, availableCatalog)
    const normalizedPreferredTarget = normalizeForMatch(link.target)
    const preferredEntry = [...availableCatalog]
      .sort(compareCatalogEntries)
      .find(
        (entry) =>
          normalizeForMatch(entry.slug) === normalizedPreferredTarget,
      )
    const preferredAlternative = preferredEntry
      ? alternatives.find(
          (candidate) =>
            candidate.target === preferredEntry.slug &&
            candidate.path === preferredEntry.path,
        )
      : undefined

    if (preferredAlternative?.matchKind === "partial") {
      preferredAlternative.matchKind = "llm-preferred"
      preferredAlternative.reason = "Validated LLM preferred target."
    } else if (preferredEntry && !preferredAlternative) {
      alternatives.push({
        target: preferredEntry.slug,
        title: preferredEntry.title,
        path: preferredEntry.path,
        band: "low",
        matchKind: "llm-preferred",
        reason: "Validated LLM preferred target.",
      })
    }

    alternatives.sort(compareCandidates)
    const selected = alternatives[0]
    if (!selected) return []

    return [
      {
        id: `${link.term}\u0000${selected.target}`,
        term: link.term,
        selectedTarget: selected.target,
        preferredTarget: preferredEntry?.slug ?? null,
        alternatives,
        band: selected.band,
        selectedByDefault: selected.band === "high",
        reason: selected.reason,
      },
    ]
  })

  return suggestions.sort((a, b) => {
    return (
      BAND_RANK[a.band] - BAND_RANK[b.band] ||
      compareText(a.term, b.term) ||
      compareText(a.id, b.id)
    )
  })
}

function compareCandidates(
  a: AutoLinkTargetCandidate,
  b: AutoLinkTargetCandidate,
): number {
  return (
    BAND_RANK[a.band] - BAND_RANK[b.band] ||
    MATCH_RANK[a.matchKind] - MATCH_RANK[b.matchKind] ||
    compareText(a.target, b.target) ||
    compareText(a.path, b.path)
  )
}

function compareCatalogEntries(
  a: PageCatalogEntry,
  b: PageCatalogEntry,
): number {
  return compareText(a.slug, b.slug) || compareText(a.path, b.path)
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
