import { readFile, writeFileAtomic, fileExists } from "@/commands/fs"
import { normalizePath, isAbsolutePath, getFileName } from "@/lib/path-utils"
import type { SavedImage } from "@/lib/extract-source-images"

/**
 * Persisted metadata from a prior `extractAndSaveSourceImages` run.
 * Lets ingest reuse `SavedImage[]` (rel paths, page numbers, sha256)
 * without re-scanning the PDF through pdfium.
 *
 * Invalidation mirrors `ingest-checkpoint`: keyed by SHA-256 of source
 * content; discarded when any listed image file is missing on disk.
 */
export interface ExtractManifest {
  version: 1
  contentHash: string
  images: SavedImage[]
  updatedAt: number
}

async function sha256(content: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(content)
  const hashBuffer = await crypto.subtle.digest("SHA-256", data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("")
}

function manifestSlug(sourceFileName: string): string {
  const cleaned = sourceFileName.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
  return cleaned.length > 0 ? cleaned : "unnamed"
}

export function extractManifestPath(projectPath: string, sourceFileName: string): string {
  return `${normalizePath(projectPath)}/.llm-wiki/extract-manifest-${manifestSlug(sourceFileName)}.json`
}

export async function loadExtractManifest(
  projectPath: string,
  sourceFileName: string,
  sourceContent: string,
): Promise<SavedImage[] | null> {
  try {
    const raw = await readFile(extractManifestPath(projectPath, sourceFileName))
    const parsed = JSON.parse(raw) as ExtractManifest
    if (parsed.version !== 1) return null
    const currentHash = await sha256(sourceContent)
    if (parsed.contentHash !== currentHash) return null

    for (const img of parsed.images) {
      const fullPath = isAbsolutePath(img.absPath)
        ? normalizePath(img.absPath)
        : `${normalizePath(projectPath)}/wiki/${img.relPath}`
      try {
        if (!(await fileExists(fullPath))) {
          console.log(
            `[extract-manifest] stale (${fullPath} missing); re-extracting "${sourceFileName}"`,
          )
          return null
        }
      } catch {
        return null
      }
    }

    return parsed.images
  } catch {
    return null
  }
}

export async function saveExtractManifest(
  projectPath: string,
  sourceFileName: string,
  sourceContent: string,
  images: SavedImage[],
): Promise<void> {
  try {
    const manifest: ExtractManifest = {
      version: 1,
      contentHash: await sha256(sourceContent),
      images,
      updatedAt: Date.now(),
    }
    await writeFileAtomic(
      extractManifestPath(projectPath, sourceFileName),
      JSON.stringify(manifest, null, 2),
    )
  } catch {
    // non-critical
  }
}

/** Convenience: manifest path slug from a full source path. */
export function sourceFileNameFromPath(sourcePath: string): string {
  return getFileName(normalizePath(sourcePath))
}
