/**
 * Node.js drop-in replacement for Tauri's @/commands/fs IPC layer.
 * Maps all Tauri invoke() calls to standard Node.js fs operations.
 *
 * Original (Tauri): invoke("read_file", { path })
 * Replacement: fs.readFileSync(path, 'utf-8')
 */
import * as fs from "fs"
import * as path from "path"

export interface FileNode {
  name: string
  path: string
  is_dir: boolean
  children?: FileNode[]
}

export interface WikiProject {
  id: string
  name: string
  path: string
}

export interface FileBase64 {
  base64: string
  mimeType: string
}

// ---------------------------------------------------------------------------
// Core file operations (replaces Tauri IPC)
// ---------------------------------------------------------------------------

export async function readFile(filePath: string): Promise<string> {
  return fs.readFileSync(filePath, "utf-8")
}

export async function writeFile(filePath: string, contents: string): Promise<void> {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, contents, "utf-8")
}

export async function listDirectory(dirPath: string): Promise<FileNode[]> {
  if (!fs.existsSync(dirPath)) {
    throw new Error(`Directory not found: ${dirPath}`)
  }
  return _listDirRecursive(dirPath)
}

function _listDirRecursive(dirPath: string): FileNode[] {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
  return entries.map((entry) => {
    const fullPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      return {
        name: entry.name,
        path: fullPath,
        is_dir: true,
        children: _listDirRecursive(fullPath),
      }
    }
    return {
      name: entry.name,
      path: fullPath,
      is_dir: false,
    }
  })
}

export async function copyFile(source: string, destination: string): Promise<void> {
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.copyFileSync(source, destination)
}

export async function deleteFile(filePath: string): Promise<void> {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath)
  }
}

export async function createDirectory(dirPath: string): Promise<void> {
  fs.mkdirSync(dirPath, { recursive: true })
}

export async function fileExists(filePath: string): Promise<boolean> {
  return fs.existsSync(filePath)
}

export async function readFileAsBase64(filePath: string): Promise<FileBase64> {
  const buffer = fs.readFileSync(filePath)
  const base64 = buffer.toString("base64")
  const ext = path.extname(filePath).toLowerCase()
  const mimeMap: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
  }
  return { base64, mimeType: mimeMap[ext] ?? "application/octet-stream" }
}

export async function preprocessFile(filePath: string): Promise<string> {
  // For non-GUI mode: just read the file as text
  // Real Tauri version uses Rust pdf-extract / docx-rs for binary formats
  return fs.readFileSync(filePath, "utf-8")
}

export async function findRelatedWikiPages(
  projectPath: string,
  sourceName: string,
): Promise<string[]> {
  const wikiDir = path.join(projectPath, "wiki")
  if (!fs.existsSync(wikiDir)) return []

  const results: string[] = []
  const searchTerm = path.basename(sourceName, path.extname(sourceName)).toLowerCase()

  function searchDir(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        searchDir(fullPath)
      } else if (entry.name.endsWith(".md")) {
        try {
          const content = fs.readFileSync(fullPath, "utf-8")
          if (content.toLowerCase().includes(searchTerm)) {
            results.push(fullPath)
          }
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  searchDir(wikiDir)
  return results
}

export async function createProject(name: string, projectPath: string): Promise<WikiProject> {
  fs.mkdirSync(projectPath, { recursive: true })
  return { id: path.basename(projectPath), name, path: projectPath }
}

export async function openProject(projectPath: string): Promise<WikiProject> {
  if (!fs.existsSync(projectPath)) {
    throw new Error(`Project not found: ${projectPath}`)
  }
  return {
    id: path.basename(projectPath),
    name: path.basename(projectPath),
    path: projectPath,
  }
}
