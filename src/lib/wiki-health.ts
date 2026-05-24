import { readFile, listDirectory } from "@/commands/fs"
import { normalizePath } from "@/lib/path-utils"
import { useReviewStore } from "@/stores/review-store"

interface HealthIssue {
  type: "orphan" | "broken-link" | "empty-page" | "duplicate-title"
  title: string
  path: string
  detail: string
}

/** Extract [[wikilinks]] from markdown content */
function extractWikiLinks(content: string): string[] {
  const re = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g
  const links: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    links.push(m[1].trim())
  }
  return links
}

/** Get the title from the first markdown heading or filename */
function extractTitle(content: string, fileName: string): string {
  const heading = content.split("\n").find((l) => l.startsWith("# "))
  return heading ? heading.replace(/^#\s+/, "").trim() : fileName.replace(/\.md$/, "")
}

/** Recursively list all .md files under wiki/ */
async function collectWikiPages(wikiPath: string): Promise<string[]> {
  const pages: string[] = []
  try {
    const nodes = await listDirectory(wikiPath)
    if (!Array.isArray(nodes)) return pages
    for (const node of nodes) {
      if (!node.is_dir && node.name.endsWith(".md")) {
        pages.push(`${wikiPath}/${node.name}`)
      } else if (node.is_dir) {
        const subPages = await collectWikiPages(`${wikiPath}/${node.name}`)
        pages.push(...subPages)
      }
    }
  } catch {
    // directory may not exist
  }
  return pages
}

/** Resolve a wikilink target to possible file paths */
function resolveLinkTarget(link: string, wikiPath: string): string[] {
  const slug = link.toLowerCase().replace(/\s+/g, "-")
  return [
    `${wikiPath}/${slug}.md`,
    `${wikiPath}/${link}.md`,
    `${wikiPath}/concepts/${slug}.md`,
    `${wikiPath}/entities/${slug}.md`,
    `${wikiPath}/queries/${slug}.md`,
  ]
}

/**
 * Run a health check on the wiki and feed issues into the review store.
 * Returns the number of issues found.
 */
export async function runHealthCheck(projectPath: string): Promise<number> {
  const pp = normalizePath(projectPath)
  const wikiPath = `${pp}/wiki`
  const issues: HealthIssue[] = []

  const pagePaths = await collectWikiPages(wikiPath)
  if (pagePaths.length === 0) return 0

  const pages = new Map<string, { content: string; title: string; path: string }>()
  const titleMap = new Map<string, string[]>()
  const backlinks = new Map<string, Set<string>>()

  for (const pagePath of pagePaths) {
    try {
      const content = await readFile(pagePath)
      const fileName = pagePath.split("/").pop() ?? ""
      const title = extractTitle(content, fileName)
      pages.set(pagePath, { content, title, path: pagePath })

      const lowerTitle = title.toLowerCase()
      if (!titleMap.has(lowerTitle)) titleMap.set(lowerTitle, [])
      titleMap.get(lowerTitle)!.push(pagePath)

      const links = extractWikiLinks(content)
      for (const link of links) {
        const targets = resolveLinkTarget(link, wikiPath)
        for (const target of targets) {
          if (!backlinks.has(target)) backlinks.set(target, new Set())
          backlinks.get(target)!.add(pagePath)
        }
      }

      const trimmed = content.replace(/^---[\s\S]*?---\n*/, "").trim()
      if (trimmed.length < 50) {
        issues.push({
          type: "empty-page",
          title,
          path: pagePath,
          detail: `Page has very little content (${trimmed.length} chars after frontmatter)`,
        })
      }
    } catch {
      // skip unreadable pages
    }
  }

  // Orphan pages
  for (const [pagePath, info] of pages) {
    const fileName = pagePath.split("/").pop() ?? ""
    if (fileName === "index.md" || fileName === "log.md" || fileName === "overview.md") continue
    const inboundLinks = backlinks.get(pagePath)
    if (!inboundLinks || inboundLinks.size === 0) {
      issues.push({
        type: "orphan",
        title: info.title,
        path: pagePath,
        detail: "No other wiki pages link to this page",
      })
    }
  }

  // Broken wikilinks
  const pagePathsSet = new Set(pagePaths)
  for (const [pagePath, info] of pages) {
    const links = extractWikiLinks(info.content)
    for (const link of links) {
      const targets = resolveLinkTarget(link, wikiPath)
      if (!targets.some((t) => pagePathsSet.has(t))) {
        issues.push({
          type: "broken-link",
          title: info.title,
          path: pagePath,
          detail: `Links to missing page: [[${link}]]`,
        })
      }
    }
  }

  // Duplicate titles
  for (const [title, paths] of titleMap) {
    if (paths.length > 1) {
      for (const path of paths) {
        issues.push({
          type: "duplicate-title",
          title,
          path,
          detail: `${paths.length} pages share the title "${title}"`,
        })
      }
    }
  }

  if (issues.length > 0) {
    const store = useReviewStore.getState()
    const relativeBase = `${pp}/wiki/`
    store.addItems(
      issues.map((issue) => ({
        type: "suggestion" as const,
        title: `Health: ${issue.type.replace("-", " ")} — ${issue.title}`,
        description: issue.detail,
        sourcePath: issue.path,
        affectedPages: [issue.path.replace(relativeBase, "").replace(/\.md$/, "")],
        options: [
          { label: "Open", action: `open:${issue.path}` },
          { label: "Dismiss", action: "dismiss" },
        ],
      })),
    )
  }

  console.log(`[Health Check] Found ${issues.length} issues across ${pages.size} pages`)
  return issues.length
}

let healthCheckTimer: ReturnType<typeof setInterval> | null = null

/** Start periodic health checks */
export function startHealthChecks(projectPath: string, intervalMs: number = 24 * 60 * 60 * 1000): void {
  stopHealthChecks()
  setTimeout(() => {
    runHealthCheck(projectPath).catch((err) =>
      console.error("[Health Check] Initial check failed:", err)
    )
  }, 30_000)

  healthCheckTimer = setInterval(() => {
    runHealthCheck(projectPath).catch((err) =>
      console.error("[Health Check] Periodic check failed:", err)
    )
  }, intervalMs)
}

/** Stop periodic health checks */
export function stopHealthChecks(): void {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer)
    healthCheckTimer = null
  }
}
