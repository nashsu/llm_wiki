/**
 * Backfill `.llm-wiki/extract-manifest-*.json` for sources that already
 * have images under `wiki/media/<slug>/` but no manifest yet.
 *
 * contentHash matches ingest: SHA-256 of `read_file` output (PDF text
 * cache at `raw/sources/.cache/<name>.pdf.txt` when present).
 *
 * Also run `backfill-ingest-checkpoint.mts` on the same project to skip
 * Stage 1 / main batches and resume catch-up for stub pages.
 *
 * Usage: npx vite-node scripts/backfill-extract-manifest.mts <project-path>
 */
import { createHash } from "node:crypto"
import { readdir, readFile, writeFile, stat, mkdir } from "node:fs/promises"
import path from "node:path"

interface SavedImage {
  index: number
  mimeType: string
  page: number | null
  width: number
  height: number
  relPath: string
  absPath: string
  sha256: string
}

function manifestSlug(sourceFileName: string): string {
  const cleaned = sourceFileName.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
  return cleaned.length > 0 ? cleaned : "unnamed"
}

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex")
}

function pngDimensions(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) {
    return { width: 0, height: 0 }
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

async function sourceTextForHash(pdfPath: string): Promise<string> {
  const cachePath = path.join(
    path.dirname(pdfPath),
    ".cache",
    `${path.basename(pdfPath)}.txt`,
  )
  try {
    return await readFile(cachePath, "utf8")
  } catch {
    return await readFile(pdfPath)
  }
}

async function buildImagesFromMedia(
  projectPath: string,
  slug: string,
): Promise<SavedImage[]> {
  const mediaDir = path.join(projectPath, "wiki", "media", slug)
  let entries: string[]
  try {
    entries = await readdir(mediaDir)
  } catch {
    return []
  }

  const imgFiles = entries
    .filter((n) => /^img-\d+\.png$/i.test(n))
    .sort((a, b) => {
      const ia = parseInt(a.match(/img-(\d+)/i)?.[1] ?? "0", 10)
      const ib = parseInt(b.match(/img-(\d+)/i)?.[1] ?? "0", 10)
      return ia - ib
    })

  const images: SavedImage[] = []
  for (const fileName of imgFiles) {
    const index = parseInt(fileName.match(/img-(\d+)/i)?.[1] ?? "0", 10)
    const absPath = path.join(mediaDir, fileName).replace(/\\/g, "/")
    const buf = await readFile(absPath)
    const { width, height } = pngDimensions(buf)
    images.push({
      index,
      mimeType: "image/png",
      page: null,
      width,
      height,
      relPath: `media/${slug}/${fileName}`.replace(/\\/g, "/"),
      absPath,
      sha256: sha256Hex(buf),
    })
  }
  return images
}

const projectPath = process.argv[2]
if (!projectPath) {
  console.error("Usage: npx vite-node scripts/backfill-extract-manifest.mts <project-path>")
  process.exit(1)
}

const pp = path.resolve(projectPath)
const sourcesDir = path.join(pp, "raw", "sources")
const llmWiki = path.join(pp, ".llm-wiki")

const st = await stat(pp).catch(() => null)
if (!st?.isDirectory()) {
  console.error(`Not a directory: ${pp}`)
  process.exit(1)
}

await mkdir(llmWiki, { recursive: true })

let entries: string[]
try {
  entries = await readdir(sourcesDir)
} catch {
  console.error(`No raw/sources under ${pp}`)
  process.exit(1)
}

const pdfs = entries.filter((n) => n.toLowerCase().endsWith(".pdf"))
let written = 0
let skipped = 0

for (const fileName of pdfs) {
  const pdfPath = path.join(sourcesDir, fileName)
  const slug = fileName.replace(/\.[^.]+$/, "")
  const images = await buildImagesFromMedia(pp, slug)
  if (images.length === 0) {
    console.log(`skip ${fileName}: no wiki/media/${slug}/ images`)
    skipped++
    continue
  }

  const sourceText = await sourceTextForHash(pdfPath)
  const manifest = {
    version: 1 as const,
    contentHash: sha256Hex(sourceText),
    images,
    updatedAt: Date.now(),
  }
  const outPath = path.join(llmWiki, `extract-manifest-${manifestSlug(fileName)}.json`)
  await writeFile(outPath, JSON.stringify(manifest, null, 2), "utf8")
  console.log(
    `wrote ${path.relative(pp, outPath)} — ${images.length} image(s), hash ${manifest.contentHash.slice(0, 12)}…`,
  )
  written++
}

console.log(`\nDone. ${written} manifest(s) written, ${skipped} skipped.`)
