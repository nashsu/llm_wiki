import { parseFrontmatter } from "@/lib/frontmatter"
import { makeQuerySlug } from "@/lib/wiki-filename"

export interface SourceSummaryPlan {
  title: string
  titleSlug: string
  slug: string
  fileName: string
  path: string
}

export interface RawDocumentNamePlan {
  title: string
  slug: string
  extension: string
  fileName: string
}

const NOISY_TITLE_PREFIX_RE = /^(?:research\s+log|research|source|deep\s+research)\s*[:：-]\s*/iu
const DATETIME_SUFFIX_RE = /(?:[-_\s(]*(?:20\d{2})[-_.년\s]?(?:0?[1-9]|1[0-2])[-_.월\s]?(?:0?[1-9]|[12]\d|3[01])(?:일)?(?:[-_.\s]?(?:[01]?\d|2[0-3])[:_.-]?[0-5]\d[:_.-]?[0-5]\d)?[)]*)$/u
const DATE_SUFFIX_RE = /(?:[-_\s(]*(?:20\d{2})[-_.년\s]?(?:0?[1-9]|1[0-2])[-_.월\s]?(?:0?[1-9]|[12]\d|3[01])(?:일)?[)]*)$/u

export function wikiTitleLanguagePolicy(): string {
  return [
    "## Wiki Title Policy",
    "- For every generated wiki page outside `wiki/entities/`, prefer Korean frontmatter `title` and Korean H1.",
    "- `wiki/entities/` is the exception: keep the official/original name for tools, products, people, organizations, models, laws, protocols, and datasets.",
    "- Preserve proper nouns, product names, legal names, acronyms, and source terms inside Korean titles when translating them would reduce precision.",
    "- Outside `wiki/entities/`, filenames should use readable natural-language file stems with spaces, matching the page title as closely as possible.",
    "- Do not insert hyphens as word separators in generated titles or filenames. Use hyphens only when they are part of an official name that would be wrong without them.",
    "- Use Korean role suffixes such as `소스 요약`, `질의 기록`, and `비교 분석` when they prevent same-title collisions across wiki folders.",
    "- Never use raw filenames, command text, Research/Deep Research prefixes, or date suffixes as page titles.",
  ].join("\n")
}

export function canonicalizeWikiTitle(value: string, fallback = "Untitled"): string {
  const fallbackTitle = fallback.trim() || "Untitled"
  let title = normalizeTitleText(value) || normalizeTitleText(fallbackTitle)
  title = title.replace(NOISY_TITLE_PREFIX_RE, "")
  title = title.replace(/^연구\s*[:：-]\s*/u, "")
  title = title.replace(/\bdeep\s*research\b/giu, "")
  title = title.replace(/\s*기록\s*$/u, "")
  title = title.replace(DATETIME_SUFFIX_RE, "")
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
  return `${makeQuerySlug(canonicalizeWikiTitle(title, "research"))} (${date.replace(/-/g, "")} ${time}).md`
}

export function buildSourceSummaryPlan(
  sourceFileName: string,
  sourceContent = "",
  explicitTitle?: string,
): SourceSummaryPlan {
  const fallback = titleFromFileName(sourceFileName)
  const baseTitle = explicitTitle?.trim()
    ? canonicalizeWikiTitle(explicitTitle, fallback)
    : extractMarkdownTitle(sourceContent, fallback)
  const title = /소스\s*요약$/u.test(baseTitle) ? baseTitle : `${baseTitle} 소스 요약`
  const titleSlug = makeQuerySlug(baseTitle)
  const slug = makeQuerySlug(title)
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
    .replace(/[‐‑‒–—―_-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
  return canonicalizeWikiTitle(stem || fileName, "Untitled")
}

export function buildRawDocumentNamePlan(
  originalFileName: string,
  sourceContent = "",
): RawDocumentNamePlan {
  const extension = extensionFromFileName(originalFileName)
  const fallback = titleFromFileName(originalFileName)
  const title = sourceContent.trim()
    ? extractMarkdownTitle(sourceContent, fallback)
    : fallback
  const slug = makeQuerySlug(title)

  return {
    title,
    slug,
    extension,
    fileName: extension ? `${slug}${extension}` : slug,
  }
}

export function buildRawFolderName(originalName: string): string {
  return makeQuerySlug(titleFromFileName(originalName))
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

function extensionFromFileName(fileName: string): string {
  const match = fileName.trim().match(/(\.[A-Za-z0-9]{1,12})$/u)
  return match ? match[1].toLowerCase() : ""
}

function scalar(value: string | string[] | undefined): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}
