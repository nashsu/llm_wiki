import { listDirectory, readFile, writeFile } from "@/commands/fs"
import { parseFrontmatter } from "@/lib/frontmatter"
import { normalizePath } from "@/lib/path-utils"
import { ensureSourcesInContent } from "@/lib/sources-merge"
import { makeQuerySlug } from "@/lib/wiki-filename"
import { resolveWikiSlugId, unwrapWikilink } from "@/lib/wiki-page-resolver"
import type { ReviewItem } from "@/stores/review-store"
import type { FileNode } from "@/types/wiki"

export interface ManifestEntity {
  name: string
  type: "entity" | "concept"
}

export interface ManifestMaterializeResult {
  stubPaths: string[]
  reviewItems: Omit<ReviewItem, "id" | "resolved" | "createdAt">[]
}

/** Marker in auto-generated stub bodies — used to detect pages catch-up should replace. */
export const MANIFEST_STUB_MARKER =
  "_Stub page — batched ingest did not emit this file"

export function isManifestStubContent(content: string): boolean {
  return content.includes(MANIFEST_STUB_MARKER)
}

/**
 * After batched entity generation, ensure every manifest entry has a
 * wiki page and surface non-manifest dangling `related:` refs as reviews.
 *
 * Policy (option A): auto-stub only manifest entities; anything else
 * referenced in `related:` but missing on disk becomes a missing-page review.
 */
export async function materializeManifestPages(
  projectPath: string,
  manifest: ManifestEntity[],
  sourceFileName: string,
  scannedPagePaths: string[],
  sourcePath?: string,
): Promise<ManifestMaterializeResult> {
  const pp = normalizePath(projectPath)
  const manifestBySlug = buildManifestIndex(manifest)
  const dedupedManifest = Array.from(manifestBySlug.values())
  const existingSlugs = await collectContentSlugs(pp)

  const stubPaths: string[] = []
  const date = new Date().toISOString().slice(0, 10)

  for (const entity of dedupedManifest) {
    const slug = entityKey(entity)
    const relPath = contentPagePath(entity, slug)

    // Page already on disk (real content or a prior stub): union this
    // ingest's source into frontmatter so source-delete can find provenance.
    if (existingSlugs.has(slug)) {
      try {
        const existing = await readFile(`${pp}/${relPath}`)
        const compensated = ensureSourcesInContent(existing, sourceFileName)
        if (compensated !== existing) {
          await writeFile(`${pp}/${relPath}`, compensated)
        }
      } catch {
        // Non-fatal — page may have been deleted between list and read.
      }
      continue
    }

    const absPath = `${pp}/${relPath}`
    try {
      await writeFile(absPath, buildManifestStub(entity, sourceFileName, date))
      existingSlugs.add(slug)
      stubPaths.push(relPath)
    } catch {
      // Non-fatal — ingest continues; unresolved related may become reviews.
    }
  }

  const reviewItems = await collectDanglingRelatedReviews(
    pp,
    scannedPagePaths,
    manifestBySlug,
    existingSlugs,
    sourcePath,
  )

  return { stubPaths, reviewItems }
}

/** First manifest row wins when multiple names collapse to the same slug. */
export function dedupeManifestBySlug(manifest: ManifestEntity[]): ManifestEntity[] {
  return Array.from(buildManifestIndex(manifest).values())
}

export function findMissingManifestEntities(
  manifest: ManifestEntity[],
  existingSlugs: Set<string>,
): ManifestEntity[] {
  return dedupeManifestBySlug(manifest).filter((e) => !existingSlugs.has(entityKey(e)))
}

/**
 * Manifest entries that need a catch-up LLM pass: no page yet, or only a
 * materialization stub from a prior/partial ingest.
 */
export async function findCatchupManifestEntities(
  projectPath: string,
  manifest: ManifestEntity[],
): Promise<ManifestEntity[]> {
  const pp = normalizePath(projectPath)
  const targets: ManifestEntity[] = []

  for (const entity of dedupeManifestBySlug(manifest)) {
    const relPath = contentPagePath(entity, entityKey(entity))
    let content = ""
    try {
      content = await readFile(`${pp}/${relPath}`)
    } catch {
      targets.push(entity)
      continue
    }
    if (isManifestStubContent(content)) targets.push(entity)
  }

  return targets
}

export async function listContentSlugs(projectPath: string): Promise<Set<string>> {
  return collectContentSlugs(normalizePath(projectPath))
}

function buildManifestIndex(manifest: ManifestEntity[]): Map<string, ManifestEntity> {
  const bySlug = new Map<string, ManifestEntity>()
  for (const entity of manifest) {
    const key = entityKey(entity)
    if (!bySlug.has(key)) bySlug.set(key, entity)
  }
  return bySlug
}

export function manifestEntitySlug(entity: ManifestEntity): string {
  return makeQuerySlug(entity.name)
}

function entityKey(entity: ManifestEntity): string {
  return manifestEntitySlug(entity)
}

function contentPagePath(entity: ManifestEntity, slug: string): string {
  const folder = entity.type === "concept" ? "concepts" : "entities"
  return `wiki/${folder}/${slug}.md`
}

export function buildManifestStub(
  entity: ManifestEntity,
  sourceFileName: string,
  date: string,
): string {
  const title = entity.name.replace(/"/g, '\\"')
  return [
    "---",
    `type: ${entity.type}`,
    `title: "${title}"`,
    `created: ${date}`,
    `updated: ${date}`,
    `sources: ["${sourceFileName}"]`,
    "tags: []",
    "related: []",
    "---",
    "",
    `# ${entity.name}`,
    "",
    `${MANIFEST_STUB_MARKER}; fill in from the source or re-ingest._`,
    "",
  ].join("\n")
}

async function collectContentSlugs(projectPath: string): Promise<Set<string>> {
  const slugs = new Set<string>()
  for (const sub of ["entities", "concepts"] as const) {
    try {
      const tree = await listDirectory(`${projectPath}/wiki/${sub}`)
      slugsFromTree(tree).forEach((s) => slugs.add(s))
    } catch {
      // folder may not exist yet
    }
  }
  return slugs
}

function slugsFromTree(nodes: FileNode[]): string[] {
  const out: string[] = []
  for (const node of nodes) {
    if (node.is_dir && node.children) out.push(...slugsFromTree(node.children))
    else if (!node.is_dir && node.name.endsWith(".md")) {
      out.push(node.name.replace(/\.md$/i, "").toLowerCase())
    }
  }
  return out
}

async function collectDanglingRelatedReviews(
  projectPath: string,
  pagePaths: string[],
  manifestBySlug: Map<string, ManifestEntity>,
  existingSlugs: Set<string>,
  sourcePath?: string,
): Promise<Omit<ReviewItem, "id" | "resolved" | "createdAt">[]> {
  // Per ADR 0002, treat Related and Wikilink as the same kind of page reference
  // and use the unified resolver: anything `resolveWikiSlugId` can map to a
  // unique page (including unique-suffix shorthand like `spark` → `apache-spark`)
  // is resolved and must not be reviewed as missing.
  const knownSlugs = new Set<string>([...manifestBySlug.keys(), ...existingSlugs])
  const seenTitles = new Set<string>()
  const items: Omit<ReviewItem, "id" | "resolved" | "createdAt">[] = []

  for (const relPath of [...new Set(pagePaths)]) {
    let content = ""
    try {
      content = await readFile(`${projectPath}/${relPath}`)
    } catch {
      continue
    }

    const related = extractRelatedSlugs(content)
    const selfSlug = relPath.replace(/^.*\//, "").replace(/\.md$/i, "").toLowerCase()

    for (const raw of related) {
      const { slug } = unwrapWikilink(raw)
      const normalized = slug.trim().toLowerCase()
      if (!normalized || normalized === selfSlug) continue
      if (resolveWikiSlugId(slug, knownSlugs) !== null) continue

      const title = `Missing page: ${slug}`
      const titleKey = title.toLowerCase()
      if (seenTitles.has(titleKey)) continue
      seenTitles.add(titleKey)

      items.push({
        type: "missing-page",
        title,
        description:
          `Referenced in \`related:\` on ${relPath} but not in the ingest manifest and no wiki page exists.`,
        sourcePath,
        affectedPages: [relPath],
        options: [
          { label: "Create Page", action: "Create Page" },
          { label: "Skip", action: "Skip" },
        ],
      })
    }
  }

  return items
}

function extractRelatedSlugs(content: string): string[] {
  const fm = parseFrontmatter(content).frontmatter
  if (!fm) return []
  const raw = fm.related
  if (!raw) return []
  if (Array.isArray(raw)) return raw.map(String)
  if (typeof raw === "string") return [raw]
  return []
}
