/**
 * 审阅项 PAGES 引用的确定性解析器。
 *
 * LLM 在 REVIEW 块的 PAGES 行给出的页面引用不可靠：可能是确切路径、
 * 裸 slug、frontmatter 标题，甚至是对中文文件名的英文转写（臆造）。
 * 本模块在写入 review-store 之前把每个引用解析为真实存在的 wiki
 * 相对路径；无法解析的引用被丢弃并上报为 ingest 警告——保证持久化的
 * affectedPages 永远指向真实页面，下游（来源并集/related/级联删除）
 * 不再消费脏引用。
 */
import { listDirectory, readFile } from "@/commands/fs"
import { parseFrontmatter } from "@/lib/frontmatter"
import { getFileStem, getRelativePath, normalizePath } from "@/lib/path-utils"
import { unwrapWikilink } from "@/lib/wiki-page-resolver"
import type { FileNode } from "@/types/wiki"

export interface PageIndexEntry {
  /** 规范的 wiki 相对路径，如 `wiki/concepts/foo.md` */
  relativePath: string
  /** frontmatter title；缺失时为 null */
  title: string | null
}

export interface PageResolutionIndex {
  byPath: Map<string, string>
  byStem: Map<string, string>
  byTitle: Map<string, string>
}

/**
 * 模糊匹配键：NFKC 统一全角/半角与兼容字形（同时覆盖 NFC/NFD 差异），
 * 再小写。仅用于解析查找，不改变存储值本身。
 */
function pageKey(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim()
}

/**
 * 由页面清单构建解析索引（纯函数，供测试直接使用）。
 *
 * :param entries: 页面清单（相对路径 + frontmatter 标题）
 * :returns: 路径/文件名主干/标题三层查找索引
 */
export function buildPageResolutionIndex(entries: PageIndexEntry[]): PageResolutionIndex {
  const byPath = new Map<string, string>()
  const byStem = new Map<string, string>()
  const byTitle = new Map<string, string>()
  for (const entry of entries) {
    const canonical = entry.relativePath
    byPath.set(pageKey(canonical), canonical)
    // 先入者优先：重名 stem/title 保留第一个，歧义引用宁可解析到稳定目标
    const stemKey = pageKey(getFileStem(canonical))
    if (!byStem.has(stemKey)) byStem.set(stemKey, canonical)
    if (entry.title) {
      const titleKey = pageKey(entry.title)
      if (!byTitle.has(titleKey)) byTitle.set(titleKey, canonical)
    }
  }
  return { byPath, byStem, byTitle }
}

/**
 * 把 PAGES 引用列表解析为真实存在的页面路径。
 *
 * 解析顺序：剥 wikilink → 精确路径（含补 wiki/ 前缀、补 .md 后缀的
 * 变体）→ 文件名主干 → frontmatter 标题；全部落空则计入 dropped。
 *
 * :param refs: LLM 给出的原始引用列表
 * :param index: buildPageResolutionIndex 产出的索引
 * :returns: resolved（去重的规范路径，保持原顺序）与 dropped（无法解析的原始引用）
 */
export function resolveAffectedPages(
  refs: string[],
  index: PageResolutionIndex,
): { resolved: string[]; dropped: string[] } {
  const resolved: string[] = []
  const dropped: string[] = []
  const seen = new Set<string>()

  for (const raw of refs) {
    const candidate = unwrapWikilink(raw.trim()).slug.trim()
    if (candidate.length === 0) continue

    const target = lookupCandidate(candidate, index)
    if (target === null) {
      dropped.push(raw)
      continue
    }
    if (!seen.has(target)) {
      seen.add(target)
      resolved.push(target)
    }
  }

  return { resolved, dropped }
}

function lookupCandidate(candidate: string, index: PageResolutionIndex): string | null {
  const normalized = candidate.replace(/^\.\//, "")
  const withMd = normalized.endsWith(".md") ? normalized : `${normalized}.md`
  // 按需补 wiki/ 前缀与 .md 后缀，Set 去重避免无意义的重复/嵌套键查询
  const pathVariants = new Set([normalized, withMd])
  if (!normalized.startsWith("wiki/")) {
    pathVariants.add(`wiki/${normalized}`)
    pathVariants.add(`wiki/${withMd}`)
  }
  for (const variant of pathVariants) {
    const hit = index.byPath.get(pageKey(variant))
    if (hit) return hit
  }
  const stemHit = index.byStem.get(pageKey(getFileStem(normalized)))
  if (stemHit) return stemHit
  const titleHit = index.byTitle.get(pageKey(normalized.replace(/\.md$/i, "")))
  if (titleHit) return titleHit
  return null
}

/** 递归收集 wiki 树下全部 .md 文件节点（大小写不敏感，供本模块与 sweep-reviews 共用）。 */
export function flattenMdFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) files.push(...flattenMdFiles(node.children))
    else if (!node.is_dir && node.name.toLowerCase().endsWith(".md")) files.push(node)
  }
  return files
}

export interface PageResolver {
  /** 解析一批 PAGES 引用；未命中时才惰性读盘补建标题索引（每实例最多一次）。 */
  resolve: (refs: string[]) => Promise<{ resolved: string[]; dropped: string[] }>
}

/**
 * 创建页面引用解析器（IO 包装，一次 ingest 建一个实例供全部审阅项共用）。
 *
 * 两阶段策略：先用一次 listDirectory 建路径/主干索引（零逐页读取），
 * 大多数引用在此命中；仅当存在未解析引用时才逐页读 frontmatter 标题
 * （经 parseFrontmatter 宽容解析）补建完整索引，且每实例只做一次。
 *
 * :param projectPath: 项目根路径
 * :returns: PageResolver；wiki 目录缺失时全部引用计入 dropped
 */
export async function createPageResolver(projectPath: string): Promise<PageResolver> {
  const pp = normalizePath(projectPath)
  let files: FileNode[] = []
  try {
    files = flattenMdFiles(await listDirectory(`${pp}/wiki`))
  } catch {
    // wiki 目录尚不存在：空索引，全部引用 dropped
  }
  const relativeOf = (file: FileNode) => {
    const relative = getRelativePath(file.path, pp)
    return relative.startsWith("wiki/") ? relative : `wiki/${file.name}`
  }

  let index = buildPageResolutionIndex(files.map((f) => ({ relativePath: relativeOf(f), title: null })))
  let titlesLoaded = false

  return {
    async resolve(refs) {
      let result = resolveAffectedPages(refs, index)
      if (result.dropped.length > 0 && !titlesLoaded && files.length > 0) {
        titlesLoaded = true
        const entries: PageIndexEntry[] = []
        for (const file of files) {
          let title: string | null = null
          try {
            const parsed = parseFrontmatter(await readFile(file.path)).frontmatter
            title = typeof parsed?.title === "string" ? parsed.title : null
          } catch {
            // 单页不可读不影响整体索引
          }
          entries.push({ relativePath: relativeOf(file), title })
        }
        index = buildPageResolutionIndex(entries)
        result = resolveAffectedPages(refs, index)
      }
      return result
    },
  }
}
