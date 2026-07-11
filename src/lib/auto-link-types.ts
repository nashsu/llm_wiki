export interface LinkEntry {
  term: string
  target: string
  alternativeTerms?: string[]
}

export interface PageCatalogEntry {
  slug: string
  title: string
  type: string
  tags: string[]
  path: string
}

export type ConfidenceBand = "high" | "medium" | "low"

export type MatchKind =
  | "slug-exact"
  | "title-exact"
  | "tag-exact"
  | "symbol-unique"
  | "cross-language-unique"
  | "title-related"
  | "ambiguous-strong"
  | "partial"
  | "llm-preferred"

export interface AutoLinkTargetCandidate {
  target: string
  title: string
  path: string
  band: ConfidenceBand
  matchKind: MatchKind
  reason: string
}

export interface AutoLinkSuggestion {
  id: string
  term: string
  selectedTarget: string
  preferredTarget: string | null
  alternatives: AutoLinkTargetCandidate[]
  band: ConfidenceBand
  selectedByDefault: boolean
  reason: string
}

export interface IgnorePair {
  term: string
  target: string
}

export interface IgnoreRules {
  terms: string[]
  pairs: IgnorePair[]
}
