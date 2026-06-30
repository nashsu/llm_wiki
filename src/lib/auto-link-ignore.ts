import { createDirectory, readFile, writeFile } from "@/commands/fs"
import type { IgnorePair, IgnoreRules } from "@/lib/auto-link-types"
import { normalizePath } from "@/lib/path-utils"

export const AUTO_LINK_IGNORE_PATH = ".llm-wiki/auto-link-ignore.json"

function projectBasePath(projectPath: string): string {
  return normalizePath(projectPath).replace(/\/+$/, "")
}

function ignoreFilePath(projectPath: string): string {
  return `${projectBasePath(projectPath)}/${AUTO_LINK_IGNORE_PATH}`
}

function normalizedComparisonValue(value: string): string {
  return value.trim().toLowerCase()
}

export function normalizeIgnoreRules(value: unknown): IgnoreRules {
  if (!value || typeof value !== "object") {
    return { terms: [], pairs: [] }
  }

  const candidate = value as { terms?: unknown; pairs?: unknown }
  const terms = Array.isArray(candidate.terms)
    ? candidate.terms
        .filter((term): term is string => typeof term === "string")
        .map((term) => term.trim())
        .filter(Boolean)
    : []
  const pairs = Array.isArray(candidate.pairs)
    ? candidate.pairs.flatMap((pair) => {
        if (!pair || typeof pair !== "object") return []
        const { term, target } = pair as { term?: unknown; target?: unknown }
        if (typeof term !== "string" || typeof target !== "string") return []
        const normalizedPair = { term: term.trim(), target: target.trim() }
        return normalizedPair.term && normalizedPair.target ? [normalizedPair] : []
      })
    : []

  return { terms, pairs }
}

export async function loadAutoLinkIgnoreRules(
  projectPath: string,
): Promise<IgnoreRules> {
  try {
    return normalizeIgnoreRules(JSON.parse(await readFile(ignoreFilePath(projectPath))))
  } catch {
    return { terms: [], pairs: [] }
  }
}

export async function saveAutoLinkIgnoreRules(
  projectPath: string,
  rules: IgnoreRules,
): Promise<void> {
  try {
    await createDirectory(`${projectBasePath(projectPath)}/.llm-wiki`)
  } catch {
    // The directory may already exist.
  }
  await writeFile(
    ignoreFilePath(projectPath),
    `${JSON.stringify(normalizeIgnoreRules(rules), null, 2)}\n`,
  )
}

export function isIgnoredTerm(term: string, rules: IgnoreRules): boolean {
  const normalizedTerm = normalizedComparisonValue(term)
  return normalizeIgnoreRules(rules).terms.some(
    (ignoredTerm) => normalizedComparisonValue(ignoredTerm) === normalizedTerm,
  )
}

export function isIgnoredPair(
  term: string,
  target: string,
  rules: IgnoreRules,
): boolean {
  const normalizedTerm = normalizedComparisonValue(term)
  const normalizedTarget = normalizedComparisonValue(target)
  return normalizeIgnoreRules(rules).pairs.some(
    (pair) =>
      normalizedComparisonValue(pair.term) === normalizedTerm &&
      normalizedComparisonValue(pair.target) === normalizedTarget,
  )
}

export async function addIgnoredTerm(
  projectPath: string,
  term: string,
): Promise<IgnoreRules> {
  const rules = await loadAutoLinkIgnoreRules(projectPath)
  const [normalizedTerm] = normalizeIgnoreRules({ terms: [term], pairs: [] }).terms
  if (normalizedTerm && !isIgnoredTerm(normalizedTerm, rules)) {
    rules.terms.push(normalizedTerm)
  }
  const normalizedRules = normalizeIgnoreRules(rules)
  await saveAutoLinkIgnoreRules(projectPath, normalizedRules)
  return normalizedRules
}

export async function addIgnoredPair(
  projectPath: string,
  pair: IgnorePair,
): Promise<IgnoreRules> {
  const rules = await loadAutoLinkIgnoreRules(projectPath)
  const [normalizedPair] = normalizeIgnoreRules({ terms: [], pairs: [pair] }).pairs
  if (
    normalizedPair &&
    !isIgnoredPair(normalizedPair.term, normalizedPair.target, rules)
  ) {
    rules.pairs.push(normalizedPair)
  }
  const normalizedRules = normalizeIgnoreRules(rules)
  await saveAutoLinkIgnoreRules(projectPath, normalizedRules)
  return normalizedRules
}
