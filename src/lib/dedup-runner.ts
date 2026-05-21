/**
 * I/O wrapper that connects the pure dedup algorithm in dedup.ts
 * to the project's filesystem + LLM. The UI layer calls these
 * functions; everything below is about read/write/spawn-llm so
 * the algorithm core stays testable without mocks of all that.
 */
import { listDirectory, readFile, writeFile, deleteFile } from "@/commands/fs"
import { streamChat } from "@/lib/llm-client"
import { normalizePath, wikiPageIdFromPath } from "@/lib/path-utils"
import type { EmbeddingConfig, LlmConfig } from "@/stores/wiki-store"
import type { ReviewItem } from "@/stores/review-store"
import type { FileNode } from "@/types/wiki"
import {
  detectDuplicateGroups,
  extractEntitySummary,
  mergeDuplicateGroup,
  rewriteIndexMd,
  type DedupLlmCall,
  type DuplicateGroup,
  type EntitySummary,
  type MergeResult,
} from "./dedup"
import { buildDedupCandidateSets, findSemanticCandidates } from "./wiki-dedup"
import { loadNotDuplicates } from "./dedup-storage"

/**
 * Wrap streamChat into the (system, user, signal) → string shape
 * the dedup module expects. Same pattern page-merge uses — keeps
 * the algorithm modules free of any LlmConfig knowledge.
 */
export function buildDedupLlmCall(llmConfig: LlmConfig): DedupLlmCall {
  return async (systemPrompt, userMessage, signal) => {
    let result = ""
    let streamError: Error | null = null
    await new Promise<void>((resolve) => {
      streamChat(
        llmConfig,
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        {
          onToken: (t) => {
            result += t
          },
          onDone: () => resolve(),
          onError: (err) => {
            streamError = err
            resolve()
          },
        },
        signal,
        { temperature: 0.1 },
      ).catch((err) => {
        streamError = err instanceof Error ? err : new Error(String(err))
        resolve()
      })
    })
    if (streamError) throw streamError
    return result
  }
}

/** Walk a FileNode tree, yielding every .md file under a given prefix. */
function* walkMd(nodes: FileNode[], prefix: string): Generator<FileNode> {
  for (const node of nodes) {
    if (node.is_dir) {
      if (node.children) yield* walkMd(node.children, prefix)
      continue
    }
    if (node.name.endsWith(".md") && node.path.includes(`${prefix}/`)) {
      yield node
    }
  }
}

/** Convert an absolute filesystem path to a wiki-relative one
 *  (`<project>/wiki/entities/foo.md` → `wiki/entities/foo.md`). */
function toWikiRelative(projectPath: string, absPath: string): string {
  const pp = normalizePath(projectPath)
  const norm = normalizePath(absPath)
  if (norm.startsWith(`${pp}/`)) return norm.slice(pp.length + 1)
  return norm
}

/**
 * Walk wiki/entities/ and wiki/concepts/, build summaries.
 * Pages that fail to parse (no frontmatter, etc.) are skipped
 * silently — they can't participate in dedup anyway.
 */
export async function loadAllEntitySummaries(
  projectPath: string,
): Promise<EntitySummary[]> {
  const pp = normalizePath(projectPath)
  const tree = await listDirectory(pp)
  const out: EntitySummary[] = []
  for (const prefix of ["wiki/entities", "wiki/concepts"]) {
    for (const node of walkMd(tree, prefix)) {
      try {
        const content = await readFile(node.path)
        const rel = toWikiRelative(pp, node.path)
        const summary = extractEntitySummary(rel, content)
        if (summary) out.push(summary)
      } catch {
        // best-effort — skip unreadable pages
      }
    }
  }
  return out
}

/** Read every .md under wiki/ as { path, content }. The path is
 *  the wiki-relative form callers downstream use. */
export async function loadAllWikiPages(
  projectPath: string,
): Promise<{ path: string; content: string }[]> {
  const pp = normalizePath(projectPath)
  const tree = await listDirectory(pp)
  const out: { path: string; content: string }[] = []
  for (const node of walkMd(tree, "wiki")) {
    try {
      const content = await readFile(node.path)
      out.push({ path: toWikiRelative(pp, node.path), content })
    } catch {
      // ignore
    }
  }
  return out
}

/**
 * Stage 1 + 2 from the user's perspective: scan the project for
 * duplicate-candidate groups. Reads notDuplicates whitelist from
 * disk so previously-confirmed false-positives don't reappear.
 */
export async function runDuplicateDetection(
  projectPath: string,
  llmConfig: LlmConfig,
  options: { signal?: AbortSignal } = {},
): Promise<DuplicateGroup[]> {
  const summaries = await loadAllEntitySummaries(projectPath)
  if (summaries.length < 2) return []
  const notDup = await loadNotDuplicates(projectPath)
  const llm = buildDedupLlmCall(llmConfig)
  return detectDuplicateGroups(summaries, llm, {
    signal: options.signal,
    notDuplicates: notDup,
  })
}

/**
 * Stage 3 + persistence: execute one user-confirmed merge.
 *
 * Steps:
 *   1. Load each group page's full content + every other wiki page
 *   2. Run mergeDuplicateGroup (LLM body merge + frontmatter
 *      union + cross-reference rewrites)
 *   3. Snapshot every touched file to .llm-wiki/page-history/
 *      dedup-<timestamp>/
 *   4. Write canonical content
 *   5. Apply cross-reference rewrites
 *   6. Delete merged-away files
 *   7. Apply index.md rewrite (separate pass — index isn't in
 *      otherWikiPages because removing references is a different
 *      operation than slug-rewriting them)
 */
export async function executeMerge(
  projectPath: string,
  group: DuplicateGroup,
  canonicalSlug: string,
  llmConfig: LlmConfig,
  options: { signal?: AbortSignal } = {},
): Promise<MergeResult> {
  const pp = normalizePath(projectPath)

  // 1. Resolve each group slug to its actual on-disk path + content
  const allPages = await loadAllWikiPages(pp)
  const pathBySlug = new Map<string, string>()
  for (const p of allPages) {
    const base = p.path.split("/").pop() ?? ""
    if (base.endsWith(".md")) {
      pathBySlug.set(base.slice(0, -3), p.path)
    }
  }
  const groupPages: { slug: string; path: string; content: string }[] = []
  for (const slug of group.slugs) {
    const relPath = pathBySlug.get(slug)
    if (!relPath) {
      throw new Error(
        `Slug "${slug}" not found on disk — was the page deleted between detection and merge?`,
      )
    }
    const page = allPages.find((p) => p.path === relPath)
    if (!page) {
      throw new Error(`Internal: page lookup miss for ${relPath}`)
    }
    groupPages.push({ slug, path: relPath, content: page.content })
  }

  const groupPaths = new Set(groupPages.map((p) => p.path))
  const otherPages = allPages.filter((p) => !groupPaths.has(p.path))

  const llm = buildDedupLlmCall(llmConfig)
  const result = await mergeDuplicateGroup(
    {
      group: groupPages,
      canonicalSlug,
      otherWikiPages: otherPages,
    },
    llm,
    { signal: options.signal },
  )

  // 2. Snapshot backup before any writes. If a write fails partway
  //    through, the user has the pre-merge state intact in
  //    .llm-wiki/page-history/.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const backupDir = `${pp}/.llm-wiki/page-history/dedup-${stamp}`
  for (const b of result.backup) {
    const sanitized = b.path.replace(/[/\\]/g, "_")
    await writeFile(`${backupDir}/${sanitized}`, b.content)
  }

  // 3. Write canonical
  await writeFile(`${pp}/${result.canonicalPath}`, result.canonicalContent)

  // 4. Apply rewrites
  for (const r of result.rewrites) {
    await writeFile(`${pp}/${r.path}`, r.newContent)
  }

  // 5. Delete merged-away pages
  for (const dead of result.pagesToDelete) {
    try {
      await deleteFile(`${pp}/${dead}`)
    } catch (err) {
      // Surface as a warning — backup is still safe.
      console.warn(`[dedup] failed to delete ${dead}: ${err}`)
    }
  }

  // 6. Rewrite index.md to drop merged-away entries.
  const indexPath = `${pp}/wiki/index.md`
  const indexEntry = allPages.find((p) => p.path === "wiki/index.md")
  if (indexEntry) {
    const removed = new Set(
      group.slugs.filter((s) => s !== canonicalSlug),
    )
    const rewritten = rewriteIndexMd(indexEntry.content, removed)
    if (rewritten !== indexEntry.content) {
      await writeFile(indexPath, rewritten)
    }
  }

  return result
}

export interface DedupPassResult {
  /** Merges actually applied this pass. */
  merged: { canonicalPath: string; deletedPaths: string[] }[]
  /** `duplicate` Review items for contradictory / uncertain groups. */
  reviews: Omit<ReviewItem, "id" | "resolved" | "createdAt">[]
  warnings: string[]
}

/**
 * The Dedup pass (ADR 0005) — an Ingest-run follow-up that runs
 * after Catch-up and before Link pass.
 *
 * For the entity/concept pages this run touched (`seedPaths`), find
 * duplication candidates via the dedupKey + vector pre-filters, run
 * the LLM detector on each small candidate set, then:
 *   - auto-merge groups the detector is confident about and whose
 *     content does not contradict;
 *   - queue a `duplicate` Review for contradictory / low-confidence
 *     groups, leaving the call to a human.
 *
 * Unlike `runDuplicateDetection` (the UI scan, which hands every
 * page to one prompt), this scopes the LLM to small pre-filtered
 * candidate sets so it scales past a few hundred pages.
 */
export async function runDedupPass(
  projectPath: string,
  seedPaths: readonly string[],
  llmConfig: LlmConfig,
  embeddingCfg: EmbeddingConfig,
  options: { signal?: AbortSignal } = {},
): Promise<DedupPassResult> {
  const result: DedupPassResult = { merged: [], reviews: [], warnings: [] }

  const summaries = await loadAllEntitySummaries(projectPath)
  if (summaries.length < 2) return result

  const summaryByPath = new Map(summaries.map((s) => [s.path, s]))
  const summaryBySlug = new Map(summaries.map((s) => [s.slug, s]))
  const pathByVectorId = new Map(
    summaries.map((s) => [wikiPageIdFromPath(s.path).toLowerCase(), s.path]),
  )
  const allPaths = summaries.map((s) => s.path)

  const seeds = seedPaths.filter((p) => summaryByPath.has(p))
  if (seeds.length === 0) return result

  // Stage 2 of the identity check: vector recall per seed. Silently
  // empty when embeddings are off — the dedupKey pre-filter still runs.
  const semanticBySeed = new Map<string, string[]>()
  for (const seed of seeds) {
    const summary = summaryByPath.get(seed)!
    let neighbours: string[] = []
    try {
      const hits = await findSemanticCandidates(
        projectPath,
        wikiPageIdFromPath(seed),
        summary.title,
        embeddingCfg,
      )
      neighbours = hits
        .map((h) => pathByVectorId.get(h.pageId.toLowerCase()))
        .filter((p): p is string => p !== undefined)
    } catch {
      // best-effort — recall failure just shrinks the candidate set
    }
    semanticBySeed.set(seed, neighbours)
  }

  const candidateSets = buildDedupCandidateSets(seeds, allPaths, semanticBySeed)
  if (candidateSets.length === 0) return result

  const notDup = await loadNotDuplicates(projectPath)
  const llm = buildDedupLlmCall(llmConfig)

  // Stage 3: LLM detection per candidate set. A group surfacing from
  // more than one set is judged once.
  const seenGroupKeys = new Set<string>()
  const groups: DuplicateGroup[] = []
  for (const set of candidateSets) {
    const subset = set
      .map((p) => summaryByPath.get(p))
      .filter((s): s is EntitySummary => s !== undefined)
    if (subset.length < 2) continue
    let detected: DuplicateGroup[]
    try {
      detected = await detectDuplicateGroups(subset, llm, {
        signal: options.signal,
        notDuplicates: notDup,
      })
    } catch (err) {
      result.warnings.push(`Dedup detection failed for a candidate set: ${errMsg(err)}`)
      continue
    }
    for (const g of detected) {
      const key = [...g.slugs].map((s) => s.toLowerCase()).sort().join(",")
      if (seenGroupKeys.has(key)) continue
      seenGroupKeys.add(key)
      groups.push(g)
    }
  }

  // Route: auto-merge confident non-contradictory groups; Review the rest.
  for (const group of groups) {
    if (group.contradictory || group.confidence === "low") {
      result.reviews.push(buildDuplicateReview(group, summaryBySlug))
      continue
    }
    try {
      const merge = await executeMerge(projectPath, group, group.canonicalSlug, llmConfig, {
        signal: options.signal,
      })
      result.merged.push({
        canonicalPath: merge.canonicalPath,
        deletedPaths: merge.pagesToDelete,
      })
    } catch (err) {
      result.warnings.push(
        `Dedup merge failed for [${group.slugs.join(", ")}]: ${errMsg(err)}`,
      )
    }
  }

  return result
}

function buildDuplicateReview(
  group: DuplicateGroup,
  summaryBySlug: Map<string, EntitySummary>,
): Omit<ReviewItem, "id" | "resolved" | "createdAt"> {
  const why = group.contradictory
    ? "their content gives conflicting definitions"
    : "the match is uncertain"
  const affectedPages = group.slugs
    .map((s) => summaryBySlug.get(s)?.path)
    .filter((p): p is string => p !== undefined)
  return {
    type: "duplicate",
    title: `Possible duplicate: ${group.slugs.join(", ")}`,
    description: `These pages may describe the same concept — ${why}. ${group.reason}`.trim(),
    affectedPages,
    options: [
      { label: "Merge", action: "Merge" },
      { label: "Not duplicates", action: "Not duplicates" },
    ],
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
