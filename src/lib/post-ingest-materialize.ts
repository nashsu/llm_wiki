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
  reviewItems: Omit<ReviewItem, "id" | "resolved" | "createdAt">[]
}

/**
 * Manifest coverage (ADR 0001 / ADR 0004): union this ingest's source
 * provenance onto manifest pages already on disk, and surface
 * non-manifest dangling `related:` refs as reviews.
 *
 * It does NOT create pages. Manifest entries without a page are left
 * for Catch-up to generate — that set is the creation queue. Stub
 * placeholder pages were removed in ADR 0004.
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

  for (const entity of dedupedManifest) {
    const slug = entityKey(entity)
    if (!existingSlugs.has(slug)) continue
    // Page on disk: union this ingest's source into frontmatter so
    // source-delete can find provenance.
    const relPath = contentPagePath(entity, slug)
    try {
      const existing = await readFile(`${pp}/${relPath}`)
      const compensated = ensureSourcesInContent(existing, sourceFileName)
      if (compensated !== existing) {
        await writeFile(`${pp}/${relPath}`, compensated)
      }
    } catch {
      // Non-fatal — page may have been deleted between list and read.
    }
  }

  const reviewItems = await collectDanglingRelatedReviews(
    pp,
    scannedPagePaths,
    manifestBySlug,
    existingSlugs,
    sourcePath,
  )

  return { reviewItems }
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
 * Manifest entries that need a catch-up LLM pass — those with no page
 * on disk. This is the creation queue Catch-up drains (ADR 0004).
 */
export async function findCatchupManifestEntities(
  projectPath: string,
  manifest: ManifestEntity[],
): Promise<ManifestEntity[]> {
  const existingSlugs = await collectContentSlugs(normalizePath(projectPath))
  return findMissingManifestEntities(manifest, existingSlugs)
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
        // ADR 0004 decision 5: a backlog Review has no one-click
        // "Create Page" (that produced ungrounded missing-page-*
        // placeholders). It resolves via grounded research, or Skip
        // — which downgrades the dangling reference to plain text.
        options: [
          { label: "Research and build", action: "__deep_research__" },
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
