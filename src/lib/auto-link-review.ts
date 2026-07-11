import type { LlmConfig } from "@/stores/wiki-store"
import type { FileNode } from "@/types/wiki"
import type { AutoLinkSuggestion } from "./auto-link-types"
import { buildAutoLinkSuggestions } from "./auto-link-candidates"
import { loadAutoLinkIgnoreRules } from "./auto-link-ignore"
import { suggestWikilinks } from "./enrich-wikilinks"
import { parseFrontmatter } from "./frontmatter"
import { normalizePath } from "./path-utils"
import { buildPageCatalog } from "./page-catalog"
import { hashAutoLinkContent } from "./auto-link-content-version"

export type AutoLinkReviewResult =
  | { status: "ready"; suggestions: AutoLinkSuggestion[]; contentHash: string }
  | { status: "empty"; message: string }
  | { status: "no-targets"; message: string }
  | { status: "none"; message: string }
  | { status: "error"; message: string }

export async function prepareAutoLinkReview(params: {
  projectPath: string
  filePath: string
  fileContent: string
  fileTree: FileNode[]
  llmConfig: LlmConfig
}): Promise<AutoLinkReviewResult> {
  const { projectPath, filePath, fileContent, fileTree, llmConfig } = params
  if (!parseFrontmatter(fileContent).body.trim()) {
    return { status: "empty", message: "This page has no content to link." }
  }

  try {
    const catalog = await buildPageCatalog(fileTree, projectPath)
    const currentPath = canonicalPath(filePath)
    const targetCatalog = catalog.filter(
      (entry) => canonicalPath(entry.path) !== currentPath,
    )
    if (targetCatalog.length === 0) {
      return {
        status: "no-targets",
        message: "Add another wiki page before creating links.",
      }
    }

    const [rawLinks, contentHash] = await Promise.all([
      suggestWikilinks(projectPath, filePath, llmConfig, { content: fileContent }),
      hashAutoLinkContent(fileContent),
    ])
    const ignoreRules = await loadAutoLinkIgnoreRules(projectPath)
    const suggestions = buildAutoLinkSuggestions(
      rawLinks,
      targetCatalog,
      ignoreRules,
    )
    if (suggestions.length === 0) {
      return { status: "none", message: "No link suggestions found." }
    }
    return { status: "ready", suggestions, contentHash }
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Auto Link failed.",
    }
  }
}

function canonicalPath(path: string): string {
  return normalizePath(path).replace(/\/{2,}/g, "/")
}
