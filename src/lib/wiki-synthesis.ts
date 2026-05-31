/**
 * Wiki Synthesis Tool (Phase 3.7 — Issue #33)
 *
 * Discovers thematic clusters in wiki concept/entity pages by tag analysis,
 * supplements with external web search (EXA.AI etc.), and generates
 * cross-article synthesis reports using LLM.
 */

import { readFile, listDirectory, writeFile, createDirectory } from "@/commands/fs"
import { parseFrontmatter } from "@/lib/frontmatter"
import { getRelativePath, normalizePath } from "@/lib/path-utils"
import { streamChat } from "@/lib/llm-client"
import { webSearch, type WebSearchResult } from "@/lib/web-search"
import { flattenMdFiles } from "@/lib/wiki-utils"
import { buildLanguageDirective } from "@/lib/output-language"
import type { FileNode } from "@/types/wiki"
import type { LlmConfig, SearchApiConfig } from "@/stores/wiki-store"

// ── Types ────────────────────────────────────────────────────────────────────

export interface TagCluster {
  /** The primary tag driving this cluster */
  tag: string
  /** Pages in this cluster */
  pages: ClusterPage[]
}

export interface ClusterPage {
  slug: string
  title: string
  type: string
  tags: string[]
  body: string
}

export interface SynthesisResult {
  ok: boolean
  topic?: string
  clusterSize?: number
  synthesisPath?: string
  externalSources?: number
  error?: string
}

// ── Helpers ──────────────────────────────────────────────────────────────────


async function scanConceptEntityPages(projectPath: string): Promise<ClusterPage[]> {
  const pp = normalizePath(projectPath)
  const wikiRoot = `${pp}/wiki`

  let tree: FileNode[]
  try {
    tree = await listDirectory(wikiRoot)
  } catch {
    return []
  }

  const allFiles = flattenMdFiles(tree)
  const pages: ClusterPage[] = []

  for (const f of allFiles) {
    try {
      const content = await readFile(f.path)
      const { frontmatter, body } = parseFrontmatter(content)
      if (!frontmatter) continue

      const type = String(frontmatter.type || "").toLowerCase()
      if (type !== "concept" && type !== "entity") continue

      const slug = getRelativePath(f.path, wikiRoot).replace(/\.md$/, "")
      const title = String(frontmatter.title || slug.split("/").pop() || "")
      const rawTags = frontmatter.tags
      const tags = Array.isArray(rawTags)
        ? rawTags.map((t) => String(t).toLowerCase().trim()).filter(Boolean)
        : typeof rawTags === "string"
          ? rawTags.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean)
          : []

      pages.push({ slug, title, type, tags, body })
    } catch {
      // skip unreadable
    }
  }

  return pages
}

/** Discover the strongest tag cluster from concept/entity pages. */
function discoverClusters(pages: ClusterPage[], minSize = 3): TagCluster[] {
  const tagGroups = new Map<string, ClusterPage[]>()

  for (const page of pages) {
    for (const tag of page.tags) {
      const group = tagGroups.get(tag) ?? []
      group.push(page)
      tagGroups.set(tag, group)
    }
  }

  // Sort by cluster size descending, filter minimum
  return [...tagGroups.entries()]
    .filter(([, group]) => group.length >= minSize)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([tag, group]) => ({ tag, pages: group }))
}

/** Build a synthesis prompt from cluster pages + external search results. */
function buildSynthesisPrompt(
  cluster: TagCluster,
  externalResults: WebSearchResult[],
  wikiIndex: string,
  languageHint: string,
): string {
  const pageSummaries = cluster.pages
    .map((p) => {
      const excerpt = p.body.slice(0, 800)
      return `### ${p.title} (${p.slug})\nTags: ${p.tags.join(", ")}\n\n${excerpt}`
    })
    .join("\n\n---\n\n")

  const externalSection = externalResults.length > 0
    ? `\n\n## External Research Sources\n\n${externalResults
        .slice(0, 5)
        .map((r) => `- **${r.title}**: ${r.snippet} (${r.url})`)
        .join("\n")}`
    : ""

  return `You are a knowledge synthesis expert. Analyze the following cluster of wiki pages about "${cluster.tag}" and produce a comprehensive synthesis report.

${languageHint}

## Wiki Pages in This Cluster (${cluster.pages.length} pages)

${pageSummaries}
${externalSection}

${wikiIndex ? `\n## Current Wiki Index\n\n${wikiIndex}\n` : ""}

## Your Task

Produce a synthesis report with this structure:

1. **Research Question**: A clear question that this cluster of pages collectively addresses
2. **Cross-Article Analysis**: Identify patterns, connections, contradictions, and gaps across the pages
3. **Key Findings**: 3-7 major insights that emerge from combining these sources
4. **Source List**: Reference each wiki page using [[wikilink]] syntax
5. **Action Recommendations**: Suggested next steps or areas for further research

Write the report as a wiki page with YAML frontmatter. Use this format:

\`\`\`
---
type: synthesis
title: "Synthesis: [your title]"
tags: [${cluster.tag}, synthesis]
created: ${new Date().toISOString().slice(0, 10)}
---

# [Title]

## Research Question
[question]

## Cross-Article Analysis
[analysis]

## Key Findings
[findings]

## Source List
[sources with [[wikilinks]]]

## Action Recommendations
[recommendations]
\`\`\`

Output ONLY the wiki page content, nothing else.`
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Run wiki synthesis: discover tag clusters, search externally, generate
 * a synthesis report via LLM, and save to wiki.
 *
 * @param projectPath - Wiki project root
 * @param llmConfig - LLM configuration for synthesis generation
 * @param searchConfig - Web search config (EXA etc.) for external sources
 * @param targetTag - Optional: force a specific tag cluster instead of auto-discovery
 * @param minClusterSize - Minimum pages to form a cluster (default 3)
 */
export async function runWikiSynthesis(
  projectPath: string,
  llmConfig: LlmConfig,
  searchConfig: SearchApiConfig,
  targetTag?: string,
  minClusterSize = 3,
): Promise<SynthesisResult> {
  const pp = normalizePath(projectPath)

  // Step 1: Scan wiki pages
  const pages = await scanConceptEntityPages(pp)
  if (pages.length === 0) {
    return { ok: false, error: "No concept/entity pages found in wiki" }
  }

  // Step 2: Discover clusters
  const clusters = discoverClusters(pages, minClusterSize)
  if (clusters.length === 0) {
    return { ok: false, error: `No tag clusters found with ≥${minClusterSize} pages` }
  }

  // Select cluster: use targetTag if specified, otherwise largest
  const cluster = targetTag
    ? clusters.find((c) => c.tag === targetTag.toLowerCase()) ?? clusters[0]
    : clusters[0]

  // Step 3: External search supplement
  let externalResults: WebSearchResult[] = []
  try {
    const searchQuery = `${cluster.tag} ${cluster.pages.map((p) => p.title).slice(0, 3).join(" ")}`
    externalResults = await webSearch(searchQuery, searchConfig, 5)
  } catch (err) {
    // External search is supplementary — don't fail the whole synthesis
    console.warn("[Synthesis] external search failed:", err instanceof Error ? err.message : err)
  }

  // Step 4: Read wiki index for context
  let wikiIndex = ""
  try {
    wikiIndex = await readFile(`${pp}/wiki/index.md`)
  } catch {
    // optional
  }

  // Step 5: Generate synthesis via LLM
  const languageHint = buildLanguageDirective(cluster.pages.map((p) => p.body).join("\n"))
  const prompt = buildSynthesisPrompt(cluster, externalResults, wikiIndex, languageHint)

  let accumulated = ""
  let streamError: unknown
  await streamChat(
    llmConfig,
    [{ role: "user", content: prompt }],
    {
      onToken: (token) => { accumulated += token },
      onDone: () => {},
      onError: (err) => { streamError = err },
    },
  )
  if (streamError) throw streamError
  if (!accumulated.trim()) {
    return { ok: false, error: "LLM returned empty response" }
  }

  // Validate LLM output has valid synthesis frontmatter (PR#35 finding #4)
  const { frontmatter: synthFm } = parseFrontmatter(accumulated.trim())
  if (!synthFm || String(synthFm.type || "").toLowerCase() !== "synthesis") {
    return { ok: false, error: "LLM output missing valid synthesis frontmatter" }
  }

  // Step 6: Save synthesis page
  const tagSlug = cluster.tag.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  const synthesisPath = `wiki/synthesis/${tagSlug}-synthesis.md`
  const fullPath = `${pp}/${synthesisPath}`

  // Ensure synthesis directory exists (PR#35 finding #1)
  const synthesisDir = `${pp}/wiki/synthesis`
  await createDirectory(synthesisDir)
  await writeFile(fullPath, accumulated.trim())

  return {
    ok: true,
    topic: cluster.tag,
    clusterSize: cluster.pages.length,
    synthesisPath,
    externalSources: externalResults.length,
  }
}
