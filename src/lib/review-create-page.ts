import { getFileStem } from "@/lib/path-utils"
import { rawSourceIdentityOrNull } from "@/lib/source-identity"
import { parseSources } from "@/lib/sources-merge"
import { unwrapWikilink } from "@/lib/wiki-page-resolver"
import type { ReviewItem } from "@/stores/review-store"

export type ReviewPageType = "entity" | "concept" | "comparison" | "synthesis" | "query"

export interface ReviewPageDraft {
  title: string
  pageType: ReviewPageType
  dir: string
}

const ACTION_PREFIX_RE = /^(Create|Save|Add|Missing page|Missing pages|缺失页面|缺少页面|创建|保存|新增)[:：\s-]*/i
const ENTITY_RE = /\b(entity|entities)\b|实体/i
const CONCEPT_RE = /\b(concept|concepts)\b|概念/i

function cleanCandidateTitle(value: string): string {
  return value
    .replace(ACTION_PREFIX_RE, "")
    .replace(/^(missing|缺失|缺少)\s*/i, "")
    .replace(/\s*(page|pages|页面|页)\s*$/i, "")
    .replace(/\s*(entity|entities|concept|concepts|实体|概念)\s*(page|pages|页面|页)?\s*$/i, "")
    .replace(/^[\s"'“”‘’`[\]【】()（）]+|[\s"'“”‘’`[\]【】()（）:：.。]+$/g, "")
    .trim()
}

function splitCandidateList(value: string): string[] {
  return value
    .replace(/\band\b/gi, ",")
    .replace(/\s+和\s+/g, ",")
    .split(/[,，、;；\n]+/)
    .map(cleanCandidateTitle)
    .filter((title) => title.length > 0)
}

function extractMissingPageCandidates(text: string): string[] {
  const candidates: string[] = []
  const segments = text
    .split(/[\n。]+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean)

  for (const segment of segments) {
    const colonTail = segment.match(/[:：]\s*(.+)$/)?.[1]
    if (colonTail) candidates.push(...splitCandidateList(colonTail))

    const chineseMissing = segment.match(/(?:缺少|缺失|未创建|没有)\s*([^；;]+?)(?:等)?\s*(?:实体|概念)?\s*(?:页面|页)(?:缺失|不存在|未创建)?/i)
    if (chineseMissing?.[1]) candidates.push(...splitCandidateList(chineseMissing[1]))

    const englishMissing = segment.match(/missing\s+(?:entity|entities|concept|concepts|page|pages)?\s*([^.;]+?)(?:\s+pages?|\s+entities?|\s+concepts?)?$/i)
    if (englishMissing?.[1]) candidates.push(...splitCandidateList(englishMissing[1]))
  }

  if (candidates.length === 0) candidates.push(cleanCandidateTitle(segments[0] ?? "") || "Untitled")

  return Array.from(new Set(candidates))
}

function detectPageType(action: string, reviewType: ReviewItem["type"], text: string): ReviewPageType {
  const combined = `${action}\n${text}`
  if (ENTITY_RE.test(combined)) return "entity"
  if (CONCEPT_RE.test(combined)) return "concept"
  if (/comparison|compare|比较/i.test(combined)) return "comparison"
  if (/synthesis|综合/i.test(combined)) return "synthesis"
  if (reviewType === "missing-page") return "concept"
  if (reviewType === "contradiction") return "query"
  if (reviewType === "suggestion") return "query"
  return "query"
}

function dirForPageType(pageType: ReviewPageType): string {
  switch (pageType) {
    case "entity":
      return "entities"
    case "concept":
      return "concepts"
    case "comparison":
      return "comparisons"
    case "synthesis":
      return "synthesis"
    case "query":
    default:
      return "queries"
  }
}

/** 把字符串转为带双引号的 YAML 标量（先转义反斜杠再转义双引号，保证标量合法闭合）。 */
const yamlStr = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`

/**
 * 收集审阅项的全部来源身份并集。
 *
 * 组成：审阅项自身来源（仅当 sourcePath 位于 raw/sources 下）
 * + 各受影响页面 frontmatter sources 中记录的来源。
 * 用于建页写入 sources 与审阅卡片的来源展示，使跨来源矛盾可直接核对全部原始文档。
 *
 * :param projectPath: 项目根路径（已规范化）
 * :param item: 审阅项
 * :param readFile: 文件读取函数（注入以保持纯逻辑可测）
 * :returns: 去重后的来源身份列表（自身来源在前）
 */
export async function collectReviewSourceIdentities(
  projectPath: string,
  item: ReviewItem,
  readFile: (path: string) => Promise<string>,
): Promise<string[]> {
  return (await collectReviewProvenance(projectPath, item, readFile)).sourceIdentities
}

/** 审阅项溯源诊断结果：来源并集 + 不可追溯时的原因分类。 */
export interface ReviewProvenance {
  /** raw/sources 来源身份并集（自身来源在前） */
  sourceIdentities: string[]
  /** sourcePath 指向 wiki 页时（deep-research 链路）的相对路径，证据为其 References 网络文献 */
  wikiSourcePage: string | null
  /** 引用了但读取失败（磁盘上不存在）的页面 */
  missingPages: string[]
  /** 存在但 frontmatter 未记录 sources 的页面 */
  pagesWithoutSources: string[]
}

/**
 * 收集审阅项的完整溯源信息：来源并集 + 断链原因分类。
 *
 * 与 collectReviewSourceIdentities 相同的并集逻辑，额外区分三类
 * "不可追溯"原因（wiki 研究页来源 / 引用页面不存在 / 页面无来源记录），
 * 供审阅卡片向用户解释来源为何为空。
 *
 * :param projectPath: 项目根路径（已规范化）
 * :param item: 审阅项
 * :param readFile: 文件读取函数（注入以保持纯逻辑可测）
 * :returns: 溯源诊断结果
 */
export async function collectReviewProvenance(
  projectPath: string,
  item: ReviewItem,
  readFile: (path: string) => Promise<string>,
): Promise<ReviewProvenance> {
  const identities: string[] = []
  const missingPages: string[] = []
  const pagesWithoutSources: string[] = []

  const own = item.sourcePath ? rawSourceIdentityOrNull(projectPath, item.sourcePath) : null
  if (own) identities.push(own)

  // sourcePath 在项目内但不在 raw/sources 下 → deep-research 摄取的 wiki 研究页
  let wikiSourcePage: string | null = null
  if (item.sourcePath && !own) {
    const sp = item.sourcePath.replace(/\\/g, "/")
    const marker = "/wiki/"
    const markerIndex = sp.indexOf(marker)
    if (markerIndex >= 0) wikiSourcePage = `wiki/${sp.slice(markerIndex + marker.length)}`
  }

  for (const page of item.affectedPages ?? []) {
    try {
      const sources = parseSources(await readFile(`${projectPath}/${page}`))
      if (sources.length === 0) pagesWithoutSources.push(page)
      identities.push(...sources)
    } catch {
      missingPages.push(page)
    }
  }

  return {
    sourceIdentities: Array.from(new Set(identities)),
    wikiSourcePage,
    missingPages,
    pagesWithoutSources,
  }
}

/**
 * 由审阅项构造新建 wiki 页面的完整内容（frontmatter + 正文）。
 *
 * 溯源链关键：sourceIdentities（原始源文件相对 raw/sources 的身份，
 * 含审阅项自身来源与受影响页面的来源并集）写入 sources 字段，
 * affectedPages 转为裸 slug 写入 related，
 * 与 ingest 直接生成页面的 frontmatter 约定保持一致。
 *
 * :param draft: 页面草稿（标题/类型/目录）
 * :param item: 审阅项（提供正文描述与 affectedPages）
 * :param date: 页面 created 日期（YYYY-MM-DD）
 * :param sourceIdentities: 原始源文件身份列表；为空时省略 sources 行
 * :returns: 可直接写盘的页面全文
 */
export function buildReviewPageContent(
  draft: ReviewPageDraft,
  item: ReviewItem,
  date: string,
  sourceIdentities: string[],
): string {
  const sources = Array.from(new Set(sourceIdentities))
  const relatedSlugs = Array.from(new Set(
    (item.affectedPages ?? [])
      .map((page) => getFileStem(unwrapWikilink(page).slug))
      .filter((slug) => slug.length > 0),
  ))

  const lines = [
    "---",
    `type: ${draft.pageType}`,
    `title: ${yamlStr(draft.title)}`,
    `created: ${date}`,
  ]
  if (sources.length > 0) lines.push(`sources: [${sources.map(yamlStr).join(", ")}]`)
  lines.push("tags: []", `related: [${relatedSlugs.map(yamlStr).join(", ")}]`, "---", "")

  return `${lines.join("\n")}\n# ${draft.title}\n\n${item.description}\n`
}

export function createReviewPageDrafts(item: ReviewItem, action: string): ReviewPageDraft[] {
  const text = `${item.title}\n${item.description}`
  const pageType = detectPageType(action, item.type, text)
  const titles = item.type === "missing-page"
    ? extractMissingPageCandidates(text)
    : [cleanCandidateTitle(item.title) || "Untitled"]

  return titles.map((title) => ({
    title,
    pageType,
    dir: dirForPageType(pageType),
  }))
}
