import { readFile, listDirectory } from "@/commands/fs"
import type { FileNode } from "@/types/wiki"
import { normalizePath } from "@/lib/path-utils"

export interface MemoryContextPage {
  title: string
  path: string
  content: string
  priority: number
}

export interface BuiltMemoryContext {
  content: string
  pages: Array<{ title: string; path: string }>
}

interface MemoryContextOptions {
  readFile?: (path: string) => Promise<string>
  listDirectory?: (path: string) => Promise<FileNode[]>
}

const MEMORY_HEADER = [
  "## Codexian Memory Context",
  "",
  "Apply this memory after the user's current request and active runtime instructions, but before general wiki retrieval.",
  "Priority: current request > runtime instructions > profile/decision/workflow > recent session > general wiki pages.",
  "Treat profile changes as reviewed memory only when memory_status is active; candidate profile memory is context, not a final fact.",
].join("\n")

const PINNED_MEMORY_PATHS = [
  "wiki/synthesis/codex-boot-context.md",
  "wiki/profile/user-operating-model.md",
  "wiki/workflows/codex-session-boot.md",
] as const

const MEMORY_DIRS = [
  { dir: "wiki/profile", priority: 10 },
  { dir: "wiki/decisions", priority: 20 },
  { dir: "wiki/workflows", priority: 30 },
  { dir: "wiki/sessions", priority: 40 },
] as const

function flattenMdFiles(nodes: readonly FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) {
      files.push(...flattenMdFiles(node.children))
    } else if (!node.is_dir && node.name.endsWith(".md")) {
      files.push(node)
    }
  }
  return files
}

function extractTitle(content: string, fallback: string): string {
  const frontmatterTitle = content.match(/^---\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim()
  if (frontmatterTitle) return frontmatterTitle
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim()
  return heading || fallback.replace(/\.md$/, "").replace(/-/g, " ")
}

function compactContent(content: string, maxChars: number): string {
  const cleaned = content.trim()
  if (cleaned.length <= maxChars) return cleaned
  return cleaned.slice(0, Math.max(0, maxChars - 18)).trimEnd() + "\n[...truncated...]"
}

export function assembleMemoryContext(pages: readonly MemoryContextPage[], budgetChars: number): BuiltMemoryContext {
  if (budgetChars <= MEMORY_HEADER.length + 32 || pages.length === 0) {
    return { content: "", pages: [] }
  }

  const ordered = [...pages].sort((a, b) => a.priority - b.priority || a.path.localeCompare(b.path))
  const chunks: string[] = [MEMORY_HEADER]
  const usedPages: Array<{ title: string; path: string }> = []
  let used = MEMORY_HEADER.length + 2
  const perPageLimit = Math.max(700, Math.floor(budgetChars / Math.min(6, ordered.length)))

  for (const page of ordered) {
    const body = compactContent(page.content, perPageLimit)
    const chunk = `### ${page.title}\nPath: ${page.path}\n\n${body}`
    if (used + chunk.length + 8 > budgetChars) continue
    chunks.push(chunk)
    usedPages.push({ title: page.title, path: page.path })
    used += chunk.length + 8
  }

  if (usedPages.length === 0) return { content: "", pages: [] }
  return { content: chunks.join("\n\n---\n\n"), pages: usedPages }
}

export async function buildMemoryContext(
  projectPath: string,
  budgetChars: number,
  options: MemoryContextOptions = {},
): Promise<BuiltMemoryContext> {
  const pp = normalizePath(projectPath)
  const read = options.readFile ?? readFile
  const list = options.listDirectory ?? listDirectory
  const seen = new Set<string>()
  const pages: MemoryContextPage[] = []

  const addPage = async (relativePath: string, priority: number) => {
    if (seen.has(relativePath)) return
    seen.add(relativePath)
    try {
      const absPath = `${pp}/${relativePath}`
      const content = await read(absPath)
      const fileName = relativePath.split("/").pop() ?? relativePath
      pages.push({
        title: extractTitle(content, fileName),
        path: relativePath,
        content,
        priority,
      })
    } catch {
      // Optional memory pages should not block normal chat retrieval.
    }
  }

  for (const relativePath of PINNED_MEMORY_PATHS) {
    await addPage(relativePath, 0)
  }

  for (const { dir, priority } of MEMORY_DIRS) {
    try {
      const files = flattenMdFiles(await list(`${pp}/${dir}`))
        .sort((a, b) => b.name.localeCompare(a.name))
        .slice(0, dir.endsWith("/sessions") ? 5 : 12)
      for (const file of files) {
        await addPage(file.path.replace(`${pp}/`, ""), priority)
      }
    } catch {
      // A project can be a non-Codexian template; skip missing memory dirs.
    }
  }

  return assembleMemoryContext(pages, budgetChars)
}
