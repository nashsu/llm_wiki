import { parseFrontmatter } from "@/lib/frontmatter"
import { makeQuerySlug } from "@/lib/wiki-filename"

export interface SourceSummaryPlan {
  title: string
  titleSlug: string
  slug: string
  fileName: string
  path: string
}

const NOISY_TITLE_PREFIX_RE = /^(?:research\s+log|research|source|deep\s+research)\s*[:：-]\s*/iu
const DATE_SUFFIX_RE = /(?:[-_\s(]*(?:20\d{2})[-_.년\s]?(?:0?[1-9]|1[0-2])[-_.월\s]?(?:0?[1-9]|[12]\d|3[01])(?:일)?[)]*)$/u

export function canonicalizeWikiTitle(value: string, fallback = "Untitled"): string {
  const fallbackTitle = fallback.trim() || "Untitled"
  let title = normalizeTitleText(value) || normalizeTitleText(fallbackTitle)
  title = title.replace(NOISY_TITLE_PREFIX_RE, "")
  title = title.replace(/^연구\s*[:：-]\s*/u, "")
  title = title.replace(/\bdeep\s*research\b/giu, "")
  title = title.replace(/\s*기록\s*$/u, "")
  title = title.replace(DATE_SUFFIX_RE, "")
  title = title
    .replace(/에\s*대해서/gu, " ")
    .replace(/최신\s*(?:공식\s*)?자료\s*(?:기준으로)?/gu, " ")
    .replace(/(?:조사해서|조사해줘|확인하고|확인해서|요약\s*정리해줘|정리해줘|요약해줘)/gu, " ")
    .replace(/\bopen\s*claw\b/giu, "OpenClaw")
    .replace(/\bgirhub\b/giu, "GitHub")
    .replace(/\bgithub\b/giu, "GitHub")
    .replace(/\brepo\b/giu, "repo")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.:;!?])/g, "$1")
    .replace(/[.。]\s*$/u, "")
    .trim()

  return title || fallbackTitle
}

export function isNoisyWikiTitle(value: string, fileName = ""): boolean {
  const title = normalizeTitleText(value)
  if (!title) return true
  if (NOISY_TITLE_PREFIX_RE.test(title)) return true
  if (/\bdeep-research\b|^deep\s+research\b/iu.test(title)) return true
  if (/조사해줘|정리해줘|요약해줘|확인하고\s+정리/iu.test(title)) return true
  if (DATE_SUFFIX_RE.test(title)) return true

  const fileStem = stripMd(fileName)
  if (fileStem && normalizeComparable(title) === normalizeComparable(fileStem)) {
    return /(?:^research-|^deep-research-|-\d{4}-\d{2}-\d{2}$|\d{8}$)/iu.test(fileStem)
  }
  return false
}

export function extractMarkdownTitle(content: string, fallback: string): string {
  const parsed = parseFrontmatter(content)
  const frontmatterTitle = scalar(parsed.frontmatter?.title)
  if (frontmatterTitle && !isNoisyWikiTitle(frontmatterTitle)) {
    return canonicalizeWikiTitle(frontmatterTitle, fallback)
  }

  const heading = parsed.body.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim()
  if (heading && !isNoisyWikiTitle(heading)) {
    return canonicalizeWikiTitle(heading, fallback)
  }

  return canonicalizeWikiTitle(frontmatterTitle ?? heading ?? fallback, fallback)
}

export function buildResearchQueryFileName(title: string, date: string, time: string): string {
  return `${makeQuerySlug(canonicalizeWikiTitle(title, "research"))}-${date}-${time}.md`
}

export function buildSourceSummaryPlan(
  sourceFileName: string,
  sourceContent = "",
  explicitTitle?: string,
): SourceSummaryPlan {
  const fallback = titleFromFileName(sourceFileName)
  const title = explicitTitle?.trim()
    ? canonicalizeWikiTitle(explicitTitle, fallback)
    : extractMarkdownTitle(sourceContent, fallback)
  const titleSlug = makeQuerySlug(title)
  const slug = titleSlug.endsWith("-source") ? titleSlug : `${titleSlug}-source`
  return {
    title,
    titleSlug,
    slug,
    fileName: `${slug}.md`,
    path: `wiki/sources/${slug}.md`,
  }
}

export function titleFromFileName(fileName: string): string {
  const stem = stripMd(fileName)
    .replace(/\.[^.]+$/u, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return canonicalizeWikiTitle(stem || fileName, "Untitled")
}

function normalizeTitleText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/^["']|["']$/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

function normalizeComparable(value: string): string {
  return stripMd(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
}

function stripMd(value: string): string {
  return value.replace(/\.md$/iu, "")
}

function scalar(value: string | string[] | undefined): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}
