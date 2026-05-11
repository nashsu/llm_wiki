import {
  copyDirectory,
  copyFile,
  deleteFile,
  fileExists,
  listDirectory,
  preprocessFile,
  readFile,
  writeFile,
} from "@/commands/fs"
import type { WikiProject, FileNode } from "@/types/wiki"
import type { DocumentLlmConfig, LlmConfig } from "@/stores/wiki-store"
import { enqueueBatch } from "@/lib/ingest-queue"
import { hasUsableDocumentLlm, hasUsableLlm } from "@/lib/has-usable-llm"
import { getFileName, getFileStem, normalizePath } from "@/lib/path-utils"
import {
  parseFrontmatterArray,
  parseSources,
  writeFrontmatterArray,
  writeSources,
} from "@/lib/sources-merge"
import { removeFromIngestCache } from "@/lib/ingest-cache"
import { removePageEmbedding } from "@/lib/embedding"
import {
  buildDeletedKeys,
  cleanIndexListing,
  normalizeWikiRefKey,
  stripDeletedWikilinks,
} from "@/lib/wiki-cleanup"
import { collectAllFilesIncludingDot } from "@/lib/sources-tree-delete"

export const INGESTABLE_SOURCE_EXTENSIONS = new Set([
  "md",
  "mdx",
  "txt",
  "pdf",
  "docx",
  "pptx",
  "xlsx",
  "xls",
  "csv",
  "json",
  "html",
  "htm",
  "rtf",
  "xml",
  "yaml",
  "yml",
])

export interface DeleteSourceResult {
  deletedWikiPaths: string[]
  rewrittenSourcePages: number
}

export interface DeleteSourceFolderResult {
  deletedWikiPaths: string[]
}

export interface DeleteSourcesResult {
  deletedWikiPaths: string[]
  rewrittenSourcePages: number
  skippedPages: number
}

export function isIngestableSourcePath(path: string): boolean {
  const normalized = normalizePath(path)
  if (normalized.split("/").includes(".cache")) return false
  const fileName = normalized.split("/").pop() ?? ""
  if (!fileName || fileName.startsWith(".")) return false
  const ext = fileName.includes(".") ? fileName.split(".").pop()?.toLowerCase() : ""
  return ext ? INGESTABLE_SOURCE_EXTENSIONS.has(ext) : false
}

export function folderContextForSourcePath(sourcePath: string, sourcesRoot = "raw/sources"): string {
  const path = normalizePath(sourcePath)
  const root = normalizePath(sourcesRoot)
  const rawMarker = "/raw/sources/"
  const rel = path.startsWith(`${root}/`)
    ? path.slice(root.length + 1)
    : path.includes(rawMarker)
      ? path.slice(path.indexOf(rawMarker) + rawMarker.length)
      : path
  const parts = rel.split("/")
  parts.pop()
  return parts.join(" > ")
}

export async function enqueueSourceIngest(
  project: WikiProject,
  sourcePaths: string[],
  llmConfig: LlmConfig,
  documentLlmConfig?: DocumentLlmConfig,
  options: { sourceRoot?: string; rootContext?: string } = {},
): Promise<string[]> {
  const llmReady = documentLlmConfig
    ? hasUsableDocumentLlm(llmConfig, documentLlmConfig)
    : hasUsableLlm(llmConfig)
  if (!llmReady) return []
  const files = sourcePaths
    .filter(isIngestableSourcePath)
    .map((sourcePath) => ({
      sourcePath,
      folderContext: withRootContext(
        folderContextForSourcePath(sourcePath, options.sourceRoot),
        options.rootContext,
      ),
    }))
  if (files.length === 0) return []
  return enqueueBatch(project.id, files)
}

export async function importSourceFiles(
  project: WikiProject,
  sourcePaths: string[],
  llmConfig: LlmConfig,
  documentLlmConfig?: DocumentLlmConfig,
): Promise<string[]> {
  const pp = normalizePath(project.path)
  const importedPaths: string[] = []

  for (const sourcePath of sourcePaths) {
    const originalName = getFileName(sourcePath) || "unknown"
    const destPath = await getUniqueDestPath(`${pp}/raw/sources`, originalName)
    try {
      await copyFile(sourcePath, destPath)
      importedPaths.push(destPath)
      preprocessFile(destPath).catch(() => {})
    } catch (err) {
      console.error(`Failed to import ${originalName}:`, err)
    }
  }

  await enqueueSourceIngest(project, importedPaths, llmConfig, documentLlmConfig)

  return importedPaths
}

export async function importSourceFolder(
  project: WikiProject,
  selectedFolder: string,
  llmConfig: LlmConfig,
  documentLlmConfig?: DocumentLlmConfig,
): Promise<string[]> {
  const pp = normalizePath(project.path)
  const folderName = getFileName(selectedFolder) || "imported"
  const destDir = `${pp}/raw/sources/${folderName}`
  const copiedFiles = await copyDirectory(selectedFolder, destDir)

  for (const filePath of copiedFiles) {
    preprocessFile(filePath).catch(() => {})
  }

  if (documentLlmConfig ? hasUsableDocumentLlm(llmConfig, documentLlmConfig) : hasUsableLlm(llmConfig)) {
    await enqueueSourceIngest(project, copiedFiles, llmConfig, documentLlmConfig, {
      sourceRoot: destDir,
      rootContext: folderName,
    })
  }

  return copiedFiles
}

export async function deleteSourceFile(
  projectPath: string,
  sourcePath: string,
  options: { fileAlreadyDeleted?: boolean; logReason?: string } = {},
): Promise<DeleteSourceResult> {
  const result = await deleteSourceFiles(projectPath, [sourcePath], options)
  return {
    deletedWikiPaths: result.deletedWikiPaths,
    rewrittenSourcePages: result.rewrittenSourcePages,
  }
}

export async function deleteSourceFiles(
  projectPath: string,
  sourcePaths: string[],
  options: { fileAlreadyDeleted?: boolean; logReason?: string } = {},
): Promise<DeleteSourcesResult> {
  const pp = normalizePath(projectPath)
  const normalizedSources = sourcePaths.map(normalizePath)
  const fileNames = normalizedSources
    .map((source) => source.split("/").pop() ?? "")
    .filter(Boolean)

  if (fileNames.length === 0) {
    return { deletedWikiPaths: [], rewrittenSourcePages: 0, skippedPages: 0 }
  }

  const deletingNames = new Set(fileNames.map((name) => name.toLowerCase()))

  if (!options.fileAlreadyDeleted) {
    for (const source of normalizedSources) {
      await deleteFile(source)
    }
  }

  for (const fileName of fileNames) {
    try {
      await deleteFile(`${pp}/raw/sources/.cache/${fileName}.txt`)
    } catch {
      // cache file may not exist
    }
    try {
      await removeFromIngestCache(pp, fileName)
    } catch {
      // non-critical
    }
  }

  const pagesToDelete: string[] = []
  let rewrittenSourcePages = 0
  let skippedPages = 0

  let allMd: FileNode[] = []
  try {
    allMd = flattenMd(await listDirectory(`${pp}/wiki`))
  } catch (err) {
    console.warn("[source-lifecycle] failed to scan wiki sources during delete:", err)
  }

  for (const file of allMd) {
    let content: string
    try {
      content = await readFile(file.path)
    } catch (err) {
      console.warn(`[source-lifecycle] failed to read ${file.path}:`, err)
      continue
    }

    const sources = parseSources(content)
    if (sources.length === 0) {
      skippedPages++
      continue
    }

    const survivors = sources.filter((source) => !sourceNameMatchesAny(source, deletingNames))
    if (survivors.length === sources.length) {
      continue
    }

    if (survivors.length === 0) {
      pagesToDelete.push(file.path)
    } else {
      try {
        await writeFile(file.path, writeSources(content, survivors))
        rewrittenSourcePages++
      } catch (err) {
        console.warn(`[source-lifecycle] failed to rewrite sources for ${file.path}:`, err)
      }
    }
  }

  let deletedWikiPaths: string[] = []
  if (pagesToDelete.length > 0) {
    const { cascadeDeleteWikiPagesWithRefs } = await import("@/lib/wiki-page-delete")
    const result = await cascadeDeleteWikiPagesWithRefs(pp, pagesToDelete)
    deletedWikiPaths = result.deletedPaths
  }

  await appendSourceDeleteLog(pp, fileNames, {
    reason: options.logReason ?? (options.fileAlreadyDeleted ? "external delete" : "delete"),
    deletedWikiCount: deletedWikiPaths.length,
    keptWikiCount: rewrittenSourcePages,
  })

  if (skippedPages > 0) {
    console.debug(
      `[source-lifecycle] skipped ${skippedPages} wiki pages with no parseable sources while deleting ${fileNames.length} source(s)`,
    )
  }

  return { deletedWikiPaths, rewrittenSourcePages, skippedPages }
}

export async function deleteSourceFolder(
  projectPath: string,
  folder: FileNode,
  options: { folderAlreadyDeleted?: boolean } = {},
): Promise<DeleteSourceFolderResult> {
  const deletedWikiPaths: string[] = []
  const files = collectAllFilesIncludingDot(folder).map((file) => file.path)
  if (files.length > 0) {
    const result = await deleteSourceFiles(projectPath, files, {
      fileAlreadyDeleted: options.folderAlreadyDeleted,
      logReason: options.folderAlreadyDeleted ? "external folder delete" : "folder delete",
    })
    deletedWikiPaths.push(...result.deletedWikiPaths)
  }

  if (!options.folderAlreadyDeleted) {
    try {
      await deleteFile(folder.path)
    } catch (err) {
      console.warn(`Failed to remove folder ${folder.path}:`, err)
    }
  }

  return { deletedWikiPaths }
}

export async function cleanupDeletedWikiPages(
  projectPath: string,
  relativePaths: string[],
): Promise<void> {
  const pp = normalizePath(projectPath)
  const deletedInfos = relativePaths
    .map((path) => ({ slug: getFileStem(path), title: "" }))
    .filter((info) => info.slug.length > 0 && !info.slug.startsWith("."))

  if (deletedInfos.length === 0) return

  for (const info of deletedInfos) {
    await removePageEmbedding(pp, info.slug)
    try {
      await deleteFile(`${pp}/wiki/media/${info.slug}`)
    } catch {
      // only source-summary pages usually own media; absence is normal
    }
  }

  const deletedKeys = buildDeletedKeys(deletedInfos)
  const wikiTree = await listDirectory(`${pp}/wiki`)
  const allMd = flattenMd(wikiTree)

  for (const file of allMd) {
    let content: string
    try {
      content = await readFile(file.path)
    } catch {
      continue
    }

    let updated = content
    if (file.path === `${pp}/wiki/index.md` || file.name === "index.md") {
      updated = cleanIndexListing(updated, deletedKeys)
    }
    updated = stripDeletedWikilinks(updated, deletedKeys)

    const related = parseFrontmatterArray(updated, "related")
    if (related.length > 0) {
      const filtered = related.filter((s) => !deletedKeys.has(normalizeWikiRefKey(s)))
      if (filtered.length !== related.length) {
        updated = writeFrontmatterArray(updated, "related", filtered)
      }
    }

    if (updated !== content) {
      try {
        await writeFile(file.path, updated)
      } catch (err) {
        console.warn(`[source-lifecycle] failed to rewrite ${file.path}:`, err)
      }
    }
  }
}

async function getUniqueDestPath(dir: string, fileName: string): Promise<string> {
  const basePath = `${dir}/${fileName}`

  if (!(await fileExists(basePath))) {
    return basePath
  }

  const ext = fileName.includes(".") ? fileName.slice(fileName.lastIndexOf(".")) : ""
  const nameWithoutExt = ext ? fileName.slice(0, -ext.length) : fileName
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "")

  const withDate = `${dir}/${nameWithoutExt}-${date}${ext}`
  if (!(await fileExists(withDate))) {
    return withDate
  }

  for (let i = 2; i <= 99; i++) {
    const withCounter = `${dir}/${nameWithoutExt}-${date}-${i}${ext}`
    if (!(await fileExists(withCounter))) {
      return withCounter
    }
  }

  return `${dir}/${nameWithoutExt}-${date}-${Date.now()}${ext}`
}

async function appendSourceDeleteLog(
  projectPath: string,
  fileNames: string | string[],
  detail: { reason: string; deletedWikiCount: number; keptWikiCount: number },
): Promise<void> {
  try {
    const names = Array.isArray(fileNames) ? fileNames : [fileNames]
    const logPath = `${projectPath}/wiki/log.md`
    const logContent = await readFile(logPath).catch(() => "# Wiki Log\n")
    const date = new Date().toISOString().slice(0, 10)
    const subject = names.length === 1 ? names[0] : `${names.length} source files`
    const listed = names.length === 1 ? "" : `\n\nSources:\n${names.map((name) => `- ${name}`).join("\n")}`
    const logEntry = `\n## [${date}] ${detail.reason} | ${subject}\n\nDeleted ${names.length} source file${names.length === 1 ? "" : "s"} and ${detail.deletedWikiCount} wiki pages.${detail.keptWikiCount > 0 ? ` ${detail.keptWikiCount} shared pages kept (have other sources).` : ""}${listed}\n`
    await writeFile(logPath, logContent.trimEnd() + logEntry)
  } catch (err) {
    console.warn("[source-lifecycle] failed to append delete log:", err)
  }
}

function flattenMd(nodes: readonly FileNode[]): FileNode[] {
  const out: FileNode[] = []
  function walk(items: readonly FileNode[]): void {
    for (const item of items) {
      if (item.is_dir) {
        if (item.children) walk(item.children)
      } else if (item.name.endsWith(".md")) {
        out.push(item)
      }
    }
  }
  walk(nodes)
  return out
}

function sourceNameMatchesAny(source: string, deletingNames: Set<string>): boolean {
  const normalizedSource = normalizePath(source).split("/").pop()?.toLowerCase() ?? ""
  return deletingNames.has(normalizedSource)
}

function withRootContext(context: string, rootContext?: string): string {
  if (!rootContext) return context
  if (!context) return rootContext
  return `${rootContext} > ${context}`
}
