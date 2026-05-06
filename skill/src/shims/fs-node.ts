/**
 * Node.js drop-in replacement for @/commands/fs (nashsu Tauri IPC layer).
 * Replaces all invoke("...") calls with standard Node.js fs operations.
 */
import * as fs from "fs"
import * as path from "path"
import type { FileNode } from "../types/wiki"

export async function readFile(filePath: string): Promise<string> {
  return fs.readFileSync(filePath, "utf-8")
}

export async function writeFile(filePath: string, content: string): Promise<void> {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, "utf-8")
}

export async function listDirectory(dirPath: string): Promise<FileNode[]> {
  function walk(dir: string): FileNode[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    return entries.map((entry) => {
      const entryPath = path.join(dir, entry.name).replace(/\\/g, "/")
      if (entry.isDirectory()) {
        return {
          name: entry.name,
          path: entryPath,
          is_dir: true,
          children: walk(entryPath),
        }
      }
      return { name: entry.name, path: entryPath, is_dir: false }
    })
  }
  return walk(dirPath)
}

export async function copyFile(from: string, to: string): Promise<void> {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
}

export async function deleteFile(filePath: string): Promise<void> {
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
}

export async function createDirectory(dirPath: string): Promise<void> {
  fs.mkdirSync(dirPath, { recursive: true })
}

export async function fileExists(filePath: string): Promise<boolean> {
  return fs.existsSync(filePath)
}

export async function readFileAsBase64(filePath: string): Promise<string> {
  return fs.readFileSync(filePath).toString("base64")
}

/**
 * Text extraction for PDFs/DOCX/etc.
 * In Node mode: returns raw file content if text-based, otherwise empty string.
 * For real PDF extraction, users should pre-extract with markitdown or pdftotext.
 */
export async function preprocessFile(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase()
  const textExts = [".md", ".txt", ".json", ".yaml", ".yml", ".csv", ".html", ".htm"]
  if (textExts.includes(ext)) {
    try {
      return fs.readFileSync(filePath, "utf-8")
    } catch {
      return ""
    }
  }
  // For binary files (PDF, DOCX, etc.) return empty — use pre-extracted markdown
  console.warn(`[fs-node] preprocessFile: binary format not supported in Node mode: ${filePath}`)
  return ""
}

export async function findRelatedWikiPages(
  sourceFile: string,
  wikiRoot: string,
): Promise<string[]> {
  const stem = path.basename(sourceFile, path.extname(sourceFile)).toLowerCase()
  const results: string[] = []
  function walk(dir: string): void {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith(".md")) {
        try {
          const content = fs.readFileSync(full, "utf-8")
          if (content.toLowerCase().includes(stem)) {
            results.push(full.replace(/\\/g, "/"))
          }
        } catch { /* skip */ }
      }
    }
  }
  walk(wikiRoot)
  return results
}
