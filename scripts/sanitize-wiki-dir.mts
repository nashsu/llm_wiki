/**
 * Batch-apply ingest write-time sanitizer to all .md files under a wiki tree.
 * Usage: npx vite-node scripts/sanitize-wiki-dir.mts <wiki-root>
 */
import { readdir, readFile, writeFile, stat } from "node:fs/promises"
import path from "node:path"
import { sanitizeIngestedFileContent } from "../src/lib/ingest-sanitize.ts"

async function collectMdFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) {
      out.push(...(await collectMdFiles(abs)))
    } else if (e.isFile() && e.name.endsWith(".md")) {
      out.push(abs)
    }
  }
  return out
}

const wikiRoot = process.argv[2]
if (!wikiRoot) {
  console.error("Usage: npx vite-node scripts/sanitize-wiki-dir.mts <wiki-root>")
  process.exit(1)
}

const root = path.resolve(wikiRoot)
const st = await stat(root).catch(() => null)
if (!st?.isDirectory()) {
  console.error(`Not a directory: ${root}`)
  process.exit(1)
}

const files = await collectMdFiles(root)
let changed = 0
let unchanged = 0
let errors = 0

for (const file of files) {
  try {
    const before = await readFile(file, "utf8")
    const after = sanitizeIngestedFileContent(before)
    if (after !== before) {
      await writeFile(file, after, "utf8")
      changed++
      console.log(`fixed: ${path.relative(root, file)}`)
    } else {
      unchanged++
    }
  } catch (err) {
    errors++
    console.error(`error: ${file}:`, err)
  }
}

console.log(
  `\nDone. ${files.length} files — ${changed} fixed, ${unchanged} unchanged, ${errors} errors.`,
)
