/**
 * Filesystem side of the OKF v0.2 export: walks the project's wiki/
 * directory, plans the bundle with `planOkfBundle` (pure), and writes it
 * to a user-chosen destination. The project itself is only ever read.
 */

import { copyFile, createDirectory, listDirectory, readFile, writeFile } from "@/commands/fs"
import { planOkfBundle, type OkfSourcePage } from "@/lib/okf-export"
import { joinPath, normalizePath } from "@/lib/path-utils"
import type { FileNode } from "@/types/wiki"

export interface OkfExportResult {
  directory: string
  filesWritten: number
  conceptCount: number
  warnings: string[]
}

function flattenFiles(nodes: readonly FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir) {
      if (node.children) files.push(...flattenFiles(node.children))
    } else {
      files.push(node)
    }
  }
  return files
}

/**
 * Export `<projectPath>/wiki` as an OKF v0.2 bundle under `destination`.
 *
 * `destination` must be empty (or not exist yet): the export writes plain
 * files and refuses to run into a non-empty directory rather than risk
 * overwriting unrelated user files.
 */
export async function runOkfExport(
  projectPath: string,
  destination: string,
): Promise<OkfExportResult> {
  const root = normalizePath(projectPath)
  const dest = normalizePath(destination)
  const wikiRoot = joinPath(root, "wiki")

  if (dest === root || dest.startsWith(`${root}/`)) {
    throw new Error("OKF export destination must be outside the project directory")
  }

  // Refuse to write into a non-empty directory. A missing directory is
  // fine — it is created below.
  let existing: FileNode[] | null = null
  try {
    existing = await listDirectory(dest, { includeHidden: true, maxDepth: 1 })
  } catch (error) {
    // listDirectory errors when the path does not exist yet; anything
    // else (permissions, not-a-directory) must surface.
    if (!/does not exist/i.test(String(error))) throw error
  }
  if (existing === null) {
    await createDirectory(dest)
  } else if (existing.length > 0) {
    throw new Error(`Export destination is not empty: ${dest}`)
  }

  const tree = await listDirectory(wikiRoot, { includeHidden: false, maxDepth: 30 })
  const files = flattenFiles(tree)

  // Only markdown participates in the OKF transformation. Non-markdown
  // assets (images, attachments) are copied byte-for-byte: readFile
  // returns placeholder text for binary formats, which would corrupt them.
  const mdFiles = files.filter((f) => f.name.toLowerCase().endsWith(".md"))
  const assetFiles = files.filter((f) => !f.name.toLowerCase().endsWith(".md"))

  const pages: OkfSourcePage[] = []
  for (const file of mdFiles) {
    const relative = normalizePath(file.path).slice(wikiRoot.length + 1)
    const content = await readFile(file.path, { extractImages: false })
    pages.push({ path: relative, content })
  }

  const plan = planOkfBundle(pages)

  for (const file of plan.files) {
    await writeFile(joinPath(dest, file.path), file.content)
  }
  for (const file of assetFiles) {
    const relative = normalizePath(file.path).slice(wikiRoot.length + 1)
    await copyFile(file.path, joinPath(dest, relative))
  }

  return {
    directory: dest,
    filesWritten: plan.files.length + assetFiles.length,
    conceptCount: plan.conceptCount,
    warnings: plan.warnings,
  }
}
