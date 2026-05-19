/**
 * Backfill `.llm-wiki/ingest-checkpoint-*.json` so a re-ingest can skip
 * Stage 1 + main entity batches and run catch-up for manifest stubs only.
 *
 * Reconstructs the Stage 1 `<entities>` manifest from wiki/entities and
 * wiki/concepts on disk. Pins `catchupTargets` to pages that still carry
 * the materialization stub marker.
 *
 * Usage: npx vite-node scripts/backfill-ingest-checkpoint.mts <project-path> [source.pdf]
 */
import { createHash } from "node:crypto"
import { readdir, readFile, writeFile, stat, mkdir } from "node:fs/promises"
import path from "node:path"
import { parseFrontmatter } from "../src/lib/frontmatter.ts"
import { parseAnalysisOutput } from "../src/lib/analysis.ts"
import { dedupAndBatchEntities } from "../src/lib/ingest.ts"
import { isManifestStubContent } from "../src/lib/post-ingest-materialize.ts"
import { checkpointPath } from "../src/lib/ingest-checkpoint.ts"
import type { IngestCheckpoint } from "../src/lib/ingest-checkpoint.ts"

const ENTITY_BATCH_SIZE = 20

type ManifestEntity = { name: string; type: "entity" | "concept" }

function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex")
}

function checkpointSlug(sourceFileName: string): string {
  const cleaned = sourceFileName.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
  return cleaned.length > 0 ? cleaned : "unnamed"
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

function dedupeManifest(entities: ManifestEntity[]): ManifestEntity[] {
  const seen = new Set<string>()
  const out: ManifestEntity[] = []
  for (const e of entities) {
    const k = e.name.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(e)
  }
  return out
}

function buildSyntheticAnalysis(entities: ManifestEntity[]): string {
  return [
    "<entities>",
    JSON.stringify(entities),
    "</entities>",
    "",
    "## Key Entities",
    "",
    "_Backfilled from existing wiki pages on disk; catch-up will replace stub bodies._",
    "",
  ].join("\n")
}

async function scanFolder(
  projectPath: string,
  folder: "entities" | "concepts",
): Promise<Array<{ entity: ManifestEntity; relPath: string; isStub: boolean }>> {
  const dir = path.join(projectPath, "wiki", folder)
  const type = folder === "concepts" ? "concept" : "entity"
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }

  const rows: Array<{ entity: ManifestEntity; relPath: string; isStub: boolean }> = []
  for (const fileName of names.filter((n) => n.endsWith(".md"))) {
    const relPath = `wiki/${folder}/${fileName}`
    const content = await readFile(path.join(projectPath, relPath), "utf8")
    const { frontmatter } = parseFrontmatter(content)
    const rawTitle = frontmatter?.title
    const title =
      typeof rawTitle === "string"
        ? rawTitle.trim()
        : fileName.replace(/\.md$/, "").replace(/-/g, " ")
    rows.push({
      entity: { name: title, type },
      relPath,
      isStub: isManifestStubContent(content),
    })
  }
  return rows
}

function catchupTargetsFromManifest(
  manifest: ManifestEntity[],
  stubByName: Map<string, boolean>,
): ManifestEntity[] {
  const targets: ManifestEntity[] = []
  for (const entity of manifest) {
    if (stubByName.get(entity.name.toLowerCase())) targets.push(entity)
  }
  return targets
}

const projectPath = process.argv[2]
const sourceFilter = process.argv[3]

if (!projectPath) {
  console.error(
    "Usage: npx vite-node scripts/backfill-ingest-checkpoint.mts <project-path> [source.pdf]",
  )
  process.exit(1)
}

const pp = path.resolve(projectPath)
const sourcesDir = path.join(pp, "raw", "sources")
const llmWiki = path.join(pp, ".llm-wiki")

if (!(await stat(pp).catch(() => null))?.isDirectory()) {
  console.error(`Not a directory: ${pp}`)
  process.exit(1)
}

await mkdir(llmWiki, { recursive: true })

const pdfNames = (await readdir(sourcesDir))
  .filter((n) => n.toLowerCase().endsWith(".pdf"))
  .filter((n) => !sourceFilter || n === sourceFilter)

if (pdfNames.length === 0) {
  console.error(`No PDF in raw/sources${sourceFilter ? ` matching ${sourceFilter}` : ""}`)
  process.exit(1)
}

const scanned = [
  ...(await scanFolder(pp, "entities")),
  ...(await scanFolder(pp, "concepts")),
]
const stubByName = new Map<string, boolean>()
for (const row of scanned) {
  stubByName.set(row.entity.name.toLowerCase(), row.isStub)
}

const manifest = dedupeManifest(scanned.map((r) => r.entity))
const catchupTargets = catchupTargetsFromManifest(manifest, stubByName)
const mainWrittenPaths = scanned.filter((r) => !r.isStub).map((r) => r.relPath)
const analysis = buildSyntheticAnalysis(manifest)
const parsed = parseAnalysisOutput(analysis, 0)

if (!parsed.manifestFound || parsed.entities.length === 0) {
  console.error("Synthetic analysis failed to parse — aborting")
  process.exit(1)
}

const batches = dedupAndBatchEntities(parsed.entities, ENTITY_BATCH_SIZE)
const completedMainBatches = batches.map((_, i) => i)
const catchupBatches = dedupAndBatchEntities(catchupTargets, 20)
const now = Date.now()

for (const fileName of pdfNames) {
  const pdfPath = path.join(sourcesDir, fileName)
  const sourceText = await sourceTextForHash(pdfPath)
  const checkpoint: IngestCheckpoint = {
    version: 1,
    contentHash: sha256Hex(sourceText),
    analysis,
    chunkCount: 1,
    isMultiChunk: false,
    mainBatchesTotal: batches.length,
    completedMainBatches,
    mainWrittenPaths,
    catchupTargets,
    completedCatchupBatches: [],
    catchupWrittenPaths: [],
    startedAt: now,
    updatedAt: now,
  }

  const outPath = checkpointPath(pp, fileName)
  await writeFile(outPath, JSON.stringify(checkpoint, null, 2), "utf8")
  console.log(`wrote ${path.relative(pp, outPath)}`)
  console.log(
    `  manifest ${manifest.length} | main done ${completedMainBatches.length}/${batches.length} | catch-up ${catchupTargets.length} target(s) → ${catchupBatches.length} batch(es)`,
  )
}

console.log("\nDone. Re-ingest with cache miss to resume catch-up only.")
