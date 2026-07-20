import { listDirectory } from "@/commands/fs"
import { useWikiStore } from "@/stores/wiki-store"
import { normalizePath } from "@/lib/path-utils"
import { filterRawSourceTree } from "@/lib/source-filter"
import type { FileNode } from "@/types/wiki"

export interface RefreshProjectFileTreeOptions {
  projectId?: string
  clearDisplayTreeFirst?: boolean
  bumpDataVersion?: boolean
  refreshDisplayTree?: boolean
  refreshPathIndex?: boolean
}

async function listDirectoryWithRetry(
  path: string,
  options: Parameters<typeof listDirectory>[1],
  attempts = 3,
): Promise<Awaited<ReturnType<typeof listDirectory>>> {
  let lastError: unknown
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await listDirectory(path, options)
    } catch (err) {
      lastError = err
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    }
  }
  throw lastError
}

function isStillCurrentProject(projectId: string | undefined, projectPath: string): boolean {
  const current = useWikiStore.getState().project
  if (!current) return false
  if (projectId && current.id !== projectId) return false
  return normalizePath(current.path) === projectPath
}

function mergeLoadedDisplayTree(existing: FileNode[], refreshed: FileNode[]): FileNode[] {
  const existingByPath = new Map(existing.map((node) => [node.path, node]))

  return refreshed.map((node) => {
    const prior = existingByPath.get(node.path)
    if (!prior?.children) return node
    if (!node.children) return { ...node, children: prior.children }
    return { ...node, children: mergeLoadedDisplayTree(prior.children, node.children) }
  })
}

export async function refreshProjectFileTree(
  projectPath: string,
  options: RefreshProjectFileTreeOptions = {},
): Promise<void> {
  const normalizedProjectPath = normalizePath(projectPath)
  const currentProjectId = options.projectId ?? useWikiStore.getState().project?.id
  const refreshDisplayTree = options.refreshDisplayTree ?? true
  const refreshPathIndex = options.refreshPathIndex ?? true

  if (options.clearDisplayTreeFirst && isStillCurrentProject(currentProjectId, normalizedProjectPath)) {
    useWikiStore.getState().setFileTree([], { syncPathIndex: false })
  }

  if (refreshDisplayTree) {
    try {
      const shallowTree = await listDirectoryWithRetry(normalizedProjectPath, { maxDepth: 2 }, 3)
      if (isStillCurrentProject(currentProjectId, normalizedProjectPath)) {
        const currentTree = useWikiStore.getState().fileTree
        const displayTree = options.clearDisplayTreeFirst
          ? shallowTree
          : mergeLoadedDisplayTree(currentTree, shallowTree)
        useWikiStore.getState().setFileTree(displayTree, { syncPathIndex: false })
      }
    } catch (err) {
      console.error("Failed to refresh project file tree:", err)
    }
  }

  if (refreshPathIndex) {
    if (!isStillCurrentProject(currentProjectId, normalizedProjectPath)) return
    // The full project scan hides dot-prefixed entries (`.git`,
    // `.llm-wiki`, …), which is correct for most of the tree. But
    // `raw/sources` may hold user-added dotfolders (`.claude`,
    // `.codex`) whose files back real `sources:` references. Scan
    // that subtree with `includeHidden` and merge it in so those
    // sources resolve instead of rendering as "not found". The
    // raw/sources scan is best-effort — a project without sources
    // must still get a full index.
    Promise.all([
      listDirectoryWithRetry(normalizedProjectPath, undefined, 3),
      listDirectoryWithRetry(
        `${normalizedProjectPath}/raw/sources`,
        { includeHidden: true },
        3,
      ).catch(() => [] as FileNode[]),
    ])
      .then(([fullTree, rawSourcesTree]) => {
        if (!isStillCurrentProject(currentProjectId, normalizedProjectPath)) return
        useWikiStore
          .getState()
          .setProjectPathIndexFromTree([...fullTree, ...filterRawSourceTree(rawSourcesTree)])
      })
      .catch((err) => {
        console.error("Failed to refresh project path index:", err)
      })
  }

  if (options.bumpDataVersion && isStillCurrentProject(currentProjectId, normalizedProjectPath)) {
    useWikiStore.getState().bumpDataVersion()
  }
}
