import { createDirectory, deleteFile, readFile, writeFileAtomic } from "@/commands/fs"
import { getFileName, getRelativePath, isAbsolutePath, normalizePath } from "@/lib/path-utils"

const PARSED_MARKDOWN_EXTENSIONS = new Set([
  "pdf",
  "doc",
  "docx",
  "docm",
  "ppt",
  "pps",
  "pot",
  "pptx",
  "pptm",
  "ppsx",
  "ppsm",
  "xls",
  "xlsx",
  "xlsm",
  "xlsb",
  "odt",
  "ods",
  "odp",
  "rtf",
  "epub",
  "mobi",
  "org",
])

/**
 * Map a parsed source to a visible, generated Markdown path. The source must
 * live below this project's raw/sources directory; refusing arbitrary paths
 * keeps this convenience export inside the project sandbox. The original
 * extension remains in the filename (report.pdf.md), avoiding collisions
 * between report.pdf, report.docx, and a user-authored report.md.
 */
export function parsedMarkdownOutputPath(
  projectPath: string,
  sourcePath: string,
): string | null {
  const project = normalizePath(projectPath).replace(/\/+$/, "")
  const source = normalizePath(sourcePath)
  const sourceRoot = `${project}/raw/sources`
  const relative = source.toLowerCase().startsWith("raw/sources/")
    ? source.slice("raw/sources/".length)
    : getRelativePath(source, sourceRoot)
  if (!relative || (relative === source && !source.toLowerCase().startsWith("raw/sources/")) || isAbsolutePath(relative)) return null
  if (relative.split("/").some((part) => !part || part === "." || part === "..")) return null

  const fileName = getFileName(relative)
  const extension = fileName.includes(".")
    ? fileName.split(".").pop()?.toLowerCase() ?? ""
    : ""
  if (!PARSED_MARKDOWN_EXTENSIONS.has(extension)) return null
  return `${project}/raw/parsed/${relative}.md`
}

export async function persistParsedMarkdown(
  projectPath: string,
  sourcePath: string,
  markdown: string,
): Promise<string | null> {
  const outputPath = parsedMarkdownOutputPath(projectPath, sourcePath)
  if (!outputPath) return null
  const parent = outputPath.slice(0, outputPath.lastIndexOf("/"))
  await createDirectory(parent)
  await writeFileAtomic(outputPath, markdown)
  return outputPath
}

/** Remove the generated parsed copy for a source. Missing copies are ignored. */
export async function removeParsedMarkdown(
  projectPath: string,
  sourcePath: string,
): Promise<void> {
  const outputPath = parsedMarkdownOutputPath(projectPath, sourcePath)
  if (!outputPath) return
  try {
    await deleteFile(outputPath)
  } catch {
    // The option may have been disabled when this source was ingested.
  }
}

/** Move a generated parsed copy alongside an unchanged source rename. */
export async function moveParsedMarkdown(
  projectPath: string,
  oldSourcePath: string,
  newSourcePath: string,
): Promise<void> {
  const oldOutputPath = parsedMarkdownOutputPath(projectPath, oldSourcePath)
  const newOutputPath = parsedMarkdownOutputPath(projectPath, newSourcePath)
  if (!oldOutputPath || !newOutputPath || oldOutputPath === newOutputPath) return
  let markdown: string
  try {
    markdown = await readFile(oldOutputPath)
  } catch {
    return
  }
  await createDirectory(newOutputPath.slice(0, newOutputPath.lastIndexOf("/")))
  await writeFileAtomic(newOutputPath, markdown)
  try {
    await deleteFile(oldOutputPath)
  } catch {
    // The destination is already durable; a stale duplicate is preferable to
    // failing the authoritative source-path migration.
  }
}
