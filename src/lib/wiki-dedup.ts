/**
 * Dedup pass — concept-identity resolution (ADR 0005).
 *
 * Stage 1 of the three-stage identity check: bucket content pages by
 * `dedupKey` to surface orthographic-duplicate clusters — case,
 * punctuation, version-number and camelCase variants of one id that
 * collapse to the same key (`map-reduce` and `mapreduce`).
 *
 * Semantic candidates (vector recall) and the same-or-not LLM
 * judgement are later stages; a cluster here is only a set of
 * candidates, not a confirmed duplicate.
 */
import { getFileStem } from "@/lib/path-utils"
import { dedupKey } from "@/lib/page-id"
import { searchByEmbedding } from "@/lib/embedding"
import type { EmbeddingConfig } from "@/stores/wiki-store"

export interface DuplicateCluster {
  /** The shared dedup key every page in the cluster collapses to. */
  key: string
  /** Page paths in the cluster (≥2), sorted for deterministic output. */
  paths: string[]
}

/**
 * Group `pagePaths` by `dedupKey` of their page id and return the
 * buckets that hold more than one page. Output is sorted (clusters
 * by key, paths within a cluster lexically) so the pass is
 * deterministic.
 */
export function findDedupKeyClusters(
  pagePaths: readonly string[],
): DuplicateCluster[] {
  const buckets = new Map<string, Set<string>>()
  for (const path of pagePaths) {
    const key = dedupKey(getFileStem(path))
    if (!key) continue
    const bucket = buckets.get(key)
    if (bucket) bucket.add(path)
    else buckets.set(key, new Set([path]))
  }

  const clusters: DuplicateCluster[] = []
  for (const [key, paths] of buckets) {
    if (paths.size > 1) {
      clusters.push({ key, paths: [...paths].sort() })
    }
  }
  return clusters.sort((a, b) => a.key.localeCompare(b.key))
}

/**
 * Build the candidate page-sets the Dedup pass hands to the LLM
 * detector. Each set is a small group of pages that MIGHT be
 * duplicates, drawn from two pre-filters:
 *
 *   - a `dedupKey` cluster that contains at least one seed page;
 *   - a seed page together with its vector-recall neighbours.
 *
 * `seedPaths` are the entity/concept pages this ingest run touched —
 * the Dedup pass only checks those, not the whole wiki (ADR 0005).
 * Identical sets are emitted once; the LLM detector and group-level
 * dedup downstream tolerate a page appearing in more than one set.
 */
export function buildDedupCandidateSets(
  seedPaths: readonly string[],
  allPaths: readonly string[],
  semanticBySeed: ReadonlyMap<string, readonly string[]>,
): string[][] {
  const seeds = new Set(seedPaths)
  const sets: string[][] = []
  const seen = new Set<string>()

  const emit = (paths: readonly string[]): void => {
    const uniq = [...new Set(paths)].sort()
    if (uniq.length < 2) return
    const key = uniq.join("\n")
    if (seen.has(key)) return
    seen.add(key)
    sets.push(uniq)
  }

  for (const cluster of findDedupKeyClusters(allPaths)) {
    if (cluster.paths.some((p) => seeds.has(p))) emit(cluster.paths)
  }
  for (const seed of seedPaths) {
    emit([seed, ...(semanticBySeed.get(seed) ?? [])])
  }
  return sets
}

export interface SemanticCandidate {
  /** Folder-qualified vector page id, e.g. `concepts/gossip-protocol`. */
  pageId: string
  score: number
}

/**
 * Stage 2 of the identity check: vector nearest-neighbour recall.
 *
 * Given a page and a query text (its title), return up to `topK`
 * semantically-near OTHER pages from the embedding index. This is
 * recall only — embedding space places antonyms (single- vs
 * multi-leader-replication) close together, so the same-or-not
 * decision is left to the LLM judge.
 */
export async function findSemanticCandidates(
  projectPath: string,
  selfPageId: string,
  queryText: string,
  cfg: EmbeddingConfig,
  topK = 8,
): Promise<SemanticCandidate[]> {
  // topK + 1: the page itself is the strongest hit and gets filtered.
  const hits = await searchByEmbedding(projectPath, queryText, cfg, topK + 1)
  const selfKey = selfPageId.toLowerCase()
  return hits
    .filter((h) => h.id.toLowerCase() !== selfKey)
    .slice(0, topK)
    .map((h) => ({ pageId: h.id, score: h.score }))
}
