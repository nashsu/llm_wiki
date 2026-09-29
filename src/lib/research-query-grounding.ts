export const PROJECT_LOCAL_TERM_QUERY_RULES = [
  "Treat ambiguous names, acronyms, character names, module names, and ordinary-looking labels as project-local vocabulary unless the supplied context clearly identifies a public meaning.",
  "Never emit a bare ambiguous term as a web query. Preserve its exact spelling and add domain, project, entity, or mechanism keywords supported by the supplied context.",
  "Do not substitute a popular public meaning for a project-local meaning.",
  "If an internal term has no likely public documentation, search for the underlying real-world concepts or comparisons needed to fill the gap.",
] as const

const TERM_MAX_LENGTH = 120
const CONTEXT_MAX_LENGTH = 180
const QUERY_MAX_LENGTH = 280

function truncateAtWord(value: string, maxLength: number): string {
  const characters = Array.from(value)
  if (characters.length <= maxLength) return value
  const truncated = characters.slice(0, maxLength).join("")
  const wordBoundary = truncated.replace(/\s+\S*$/, "").trim()
  return Array.from(wordBoundary).length >= maxLength * 0.6
    ? wordBoundary
    : truncated.trim()
}

function compactTerm(value: string): string {
  return truncateAtWord(value
    .replace(/^["']|["']$/g, "")
    .replace(/^\[\[|\]\]$/g, "")
    .replace(/\s+/g, " ")
    .trim(), TERM_MAX_LENGTH)
}

function compactContext(value: string): string {
  return truncateAtWord(value
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")
    .replace(/[`*_>[\](){}]/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\s+/g, " ")
    .trim(), CONTEXT_MAX_LENGTH)
}

export function groundedFallbackResearchQuery(term: string, context: string): string {
  const termPart = compactTerm(term)
  const contextPart = compactContext(context)
  if (!contextPart) return termPart
  if (!termPart) return contextPart
  return truncateAtWord(`${termPart} ${contextPart}`, QUERY_MAX_LENGTH)
}

export function groundBareResearchQueries(
  queries: string[],
  term: string,
  context: string,
  bareAliases: string[] = [],
): string[] {
  const bareTerms = new Set([term, ...bareAliases]
    .map(compactTerm)
    .filter(Boolean)
    .map((value) => value.toLocaleLowerCase()))
  const fallback = groundedFallbackResearchQuery(term, context)
  const grounded = queries.map((query) => {
    const normalized = query.replace(/\s+/g, " ").trim()
    const comparisonKey = compactTerm(normalized).toLocaleLowerCase()
    return normalized && !bareTerms.has(comparisonKey)
      ? normalized
      : fallback
  }).filter(Boolean)
  const seen = new Set<string>()
  return grounded.filter((query) => {
    const key = query.toLocaleLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
