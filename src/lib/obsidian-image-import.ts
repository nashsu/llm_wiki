import {
  copyFile,
  createDirectory,
  fileExists,
  listDirectory,
  readFile,
} from "@/commands/fs"
import { findLocalMarkdownImageRefs } from "@/lib/extract-source-images"
import { getFileName, normalizePath } from "@/lib/path-utils"
import type { FileNode } from "@/types/wiki"

/**
 * 函数作用：取得路径的父目录。
 * 输入参数：
 *     path: 文件或目录路径。
 * 输出参数：
 *     返回规范化后的父目录；没有父目录时返回空字符串。
 */
function parentPath(path: string): string {
  const normalized = normalizePath(path)
  const index = normalized.lastIndexOf("/")
  return index > 0 ? normalized.slice(0, index) : ""
}

/**
 * 函数作用：把目录树展开为文件列表。
 * 输入参数：
 *     nodes: 文件目录树节点。
 * 输出参数：
 *     返回目录树中的全部文件节点。
 */
function flattenFiles(nodes: FileNode[]): FileNode[] {
  const files: FileNode[] = []
  for (const node of nodes) {
    if (node.is_dir) {
      files.push(...flattenFiles(node.children ?? []))
    } else {
      files.push(node)
    }
  }
  return files
}

/**
 * 函数作用：从 Markdown 所在目录向上查找 Obsidian Vault 根目录。
 * 输入参数：
 *     markdownPath: 原始 Markdown 文件路径。
 * 输出参数：
 *     返回包含 .obsidian 目录的路径；未找到时返回 null。
 */
async function findObsidianVaultRoot(markdownPath: string): Promise<string | null> {
  let current = parentPath(markdownPath)
  while (current) {
    if (await fileExists(`${current}/.obsidian`)) return current
    const next = parentPath(current)
    if (!next || next === current) break
    current = next
  }
  return null
}

/**
 * 函数作用：根据 Obsidian 的解析习惯定位本地图片。
 * 输入参数：
 *     reference: Markdown 中的图片引用。
 *     markdownDir: 原始 Markdown 所在目录。
 *     vaultFilesByName: Vault 文件名索引。
 * 输出参数：
 *     返回图片的绝对路径；找不到时返回 null。
 */
async function resolveImageSource(
  reference: string,
  markdownDir: string,
  vaultFilesByName: Map<string, string>,
): Promise<string | null> {
  const normalizedRef = normalizePath(reference)
  const relativeCandidate = normalizePath(`${markdownDir}/${normalizedRef}`)
  if (await fileExists(relativeCandidate)) return relativeCandidate

  return vaultFilesByName.get(getFileName(normalizedRef).toLowerCase()) ?? null
}

/**
 * 函数作用：把 Obsidian Markdown 引用的跨目录图片复制到导入目标旁边。
 * 输入参数：
 *     sourceMarkdownPath: 导入前的 Markdown 文件路径。
 *     destinationMarkdownPath: 导入后的 Markdown 文件路径。
 * 输出参数：
 *     返回成功复制的图片数量。
 */
export async function importObsidianMarkdownImages(
  sourceMarkdownPath: string,
  destinationMarkdownPath: string,
): Promise<number> {
  const markdown = await readFile(sourceMarkdownPath)
  const references = findLocalMarkdownImageRefs(markdown)
  if (references.length === 0) return 0

  const sourceDir = parentPath(sourceMarkdownPath)
  const destinationDir = parentPath(destinationMarkdownPath)
  const vaultRoot = await findObsidianVaultRoot(sourceMarkdownPath)
  const vaultFilesByName = new Map<string, string>()

  if (vaultRoot) {
    const vaultFiles = flattenFiles(await listDirectory(vaultRoot))
    for (const file of vaultFiles) {
      const key = file.name.toLowerCase()
      if (!vaultFilesByName.has(key)) vaultFilesByName.set(key, normalizePath(file.path))
    }
  }

  let copied = 0
  for (const reference of references) {
    const sourceImage = await resolveImageSource(reference, sourceDir, vaultFilesByName)
    if (!sourceImage) continue

    const normalizedRef = normalizePath(reference)
    const destinationImage = normalizedRef.includes("/")
      ? normalizePath(`${destinationDir}/${normalizedRef}`)
      : normalizePath(`${destinationDir}/${getFileName(normalizedRef)}`)
    const imageParent = parentPath(destinationImage)
    if (imageParent) await createDirectory(imageParent)
    await copyFile(sourceImage, destinationImage)
    copied += 1
  }

  return copied
}
