import { canonicalizePath, listDirectory } from "@/commands/fs"
import { buildWikiAnswerContext } from "@/lib/wiki-answer-context"
import { saveQueryPage } from "@/lib/save-query-page"
import { runSemanticLint, runStructuralLint, type LintResult } from "@/lib/lint"
import { fixLintResult } from "@/lib/lint-fixer"
import { enrichWithWikilinks } from "@/lib/enrich-wikilinks"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { autoIngest, captionSourceImages } from "@/lib/ingest"
import { isAbsolutePath, normalizePath } from "@/lib/path-utils"
import { useWikiStore } from "@/stores/wiki-store"
import type { AgentWikiChangedPayload } from "./agent-types"

export interface AgentAppToolResponse {
  ok: true
  result: unknown
  changedPaths?: string[]
  wikiChanged?: AgentWikiChangedPayload[]
}

type ToolArgs = Record<string, unknown>

function currentProject() {
  const project = useWikiStore.getState().project
  if (!project) throw new Error("No active project")
  return project
}

function stringArg(args: ToolArgs, key: string): string {
  const value = args[key]
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing ${key}`)
  }
  return value
}

function optionalStringArray(args: ToolArgs, key: string): string[] | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${key} must be a string array`)
  }
  return value
}

function normalizePagePath(projectPath: string, input: string): string {
  const pp = normalizePath(projectPath)
  const path = normalizePath(input)
  if (path.startsWith(`${pp}/`)) return path
  if (path.startsWith("wiki/")) return `${pp}/${path}`
  return `${pp}/wiki/${path}`
}

async function normalizeSourcePath(projectPath: string, input: string): Promise<string> {
  const pp = normalizePath(projectPath).replace(/\/+$/, "")
  const rawSourcesRoot = `${pp}/raw/sources/`
  const rawSourcesPrefix = "raw/sources/"
  const sourcesPrefix = "sources/"
  let path: string
  try {
    path = normalizePath(decodeURIComponent(input.trim()))
  } catch {
    throw new Error("sourcePath has invalid URI encoding")
  }

  const assertSafeRelativeSource = (relPath: string): string => {
    const segments = relPath.split("/")
    if (
      relPath.length === 0 ||
      segments.some((segment) => segment === ".." || segment === "." || segment === "")
    ) {
      throw new Error("sourcePath must not contain traversal segments")
    }
    return relPath
  }

  let candidate: string
  if (path.startsWith(rawSourcesRoot)) {
    assertSafeRelativeSource(path.slice(rawSourcesRoot.length))
    candidate = path
  } else if (path.startsWith(`${pp}/`) || isAbsolutePath(path)) {
    throw new Error("sourcePath must be inside the active project")
  } else if (path.startsWith(rawSourcesPrefix)) {
    assertSafeRelativeSource(path.slice(rawSourcesPrefix.length))
    candidate = `${pp}/${path}`
  } else if (path.startsWith(sourcesPrefix)) {
    const relPath = assertSafeRelativeSource(path.slice(sourcesPrefix.length))
    candidate = `${rawSourcesRoot}${relPath}`
  } else {
    candidate = `${rawSourcesRoot}${assertSafeRelativeSource(path)}`
  }

  const canonicalRoot = normalizePath(await canonicalizePath(`${pp}/raw/sources`)).replace(/\/+$/, "")
  const canonicalCandidate = normalizePath(await canonicalizePath(candidate))
  if (canonicalCandidate !== canonicalRoot && !canonicalCandidate.startsWith(`${canonicalRoot}/`)) {
    throw new Error("sourcePath must resolve inside raw/sources")
  }
  return canonicalCandidate
}

function wikiChangedFromPaths(paths: string[]): AgentWikiChangedPayload[] {
  return paths
    .filter((path) => path.startsWith("wiki/"))
    .map((path) => ({ path, operation: "update" as const }))
}

function lintResultArg(args: ToolArgs): LintResult {
  const value = args.result
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("result must be a lint result object")
  }
  const result = value as Partial<LintResult>
  if (
    !["orphan", "broken-link", "no-outlinks", "semantic"].includes(String(result.type)) ||
    !["warning", "info"].includes(String(result.severity)) ||
    typeof result.page !== "string" ||
    typeof result.detail !== "string"
  ) {
    throw new Error("Invalid lint result")
  }
  return {
    type: result.type as LintResult["type"],
    severity: result.severity as LintResult["severity"],
    page: result.page,
    detail: result.detail,
    affectedPages: Array.isArray(result.affectedPages)
      ? result.affectedPages.filter((item): item is string => typeof item === "string")
      : undefined,
  }
}

/**
 * Runs app-level Agent tools inside the WebView, where existing LLM Wiki
 * business services and Tauri commands are available.
 */
export async function runAgentAppTool(
  toolName: string,
  args: ToolArgs,
): Promise<AgentAppToolResponse> {
  const project = currentProject()
  const state = useWikiStore.getState()
  const projectPath = project.path

  if (toolName === "build_answer_context") {
    const maxContextSize =
      typeof args.maxContextSize === "number" ? args.maxContextSize : state.llmConfig.maxContextSize
    const context = await buildWikiAnswerContext({
      project,
      query: stringArg(args, "query"),
      maxContextSize,
      dataVersion: state.dataVersion,
    })
    return { ok: true, result: context }
  }

  if (toolName === "save_query_page") {
    const result = await saveQueryPage({
      projectPath,
      content: stringArg(args, "content"),
      title: typeof args.title === "string" ? args.title : undefined,
      tags: optionalStringArray(args, "tags"),
      autoIngest: args.autoIngest === true,
      llmConfig: state.llmConfig,
    })
    state.setFileTree(result.fileTree)
    useWikiStore.getState().bumpDataVersion()
    return {
      ok: true,
      result: {
        path: result.path,
        relativePath: result.relativePath,
        title: result.title,
        fileName: result.fileName,
        date: result.date,
        autoIngestStarted: result.autoIngestStarted,
      },
      wikiChanged: [{ path: result.relativePath, operation: "create" }],
    }
  }

  if (toolName === "run_lint") {
    const includeStructural = args.includeStructural !== false
    const includeSemantic = args.includeSemantic === true
    const structural = includeStructural ? await runStructuralLint(projectPath) : []
    const semantic =
      includeSemantic && hasUsableLlm(state.llmConfig)
        ? await runSemanticLint(projectPath, state.llmConfig)
        : []
    return {
      ok: true,
      result: {
        results: [...structural, ...semantic],
        structuralCount: structural.length,
        semanticCount: semantic.length,
        semanticSkipped: includeSemantic && !hasUsableLlm(state.llmConfig),
      },
    }
  }

  if (toolName === "ingest_source") {
    const sourcePath = await normalizeSourcePath(projectPath, stringArg(args, "sourcePath"))
    const folderContext = typeof args.folderContext === "string" ? args.folderContext : undefined
    const writtenPaths = await autoIngest(projectPath, sourcePath, state.llmConfig, undefined, folderContext)
    state.setFileTree(await listDirectory(projectPath))
    useWikiStore.getState().bumpDataVersion()
    return {
      ok: true,
      result: {
        sourcePath,
        writtenPaths,
        filesWritten: writtenPaths.length,
      },
      wikiChanged: wikiChangedFromPaths(writtenPaths),
    }
  }

  if (toolName === "caption_source_images") {
    const sourcePath = await normalizeSourcePath(projectPath, stringArg(args, "sourcePath"))
    const result = await captionSourceImages(
      projectPath,
      sourcePath,
      state.llmConfig,
      undefined,
      args.forceRecaption === true,
    )
    state.setFileTree(await listDirectory(projectPath))
    useWikiStore.getState().bumpDataVersion()
    const wikiChanged = result.sourceSummaryUpdated
      ? [{ path: result.sourceSummaryPath, operation: "update" as const }]
      : []
    return {
      ok: true,
      result,
      wikiChanged,
    }
  }

  if (toolName === "fix_lint_result") {
    const result = lintResultArg(args)
    const ok = await fixLintResult(projectPath, result, state.llmConfig)
    if (ok) {
      state.setFileTree(await listDirectory(projectPath))
      useWikiStore.getState().bumpDataVersion()
    }
    const changedPath = `wiki/${result.page}`
    return {
      ok: true,
      result: { fixed: ok, result },
      wikiChanged: ok ? [{ path: changedPath, operation: "update" }] : [],
    }
  }

  if (toolName === "enrich_wikilinks") {
    const filePath = normalizePagePath(projectPath, stringArg(args, "path"))
    await enrichWithWikilinks(projectPath, filePath, state.llmConfig)
    state.setFileTree(await listDirectory(projectPath))
    const relativePath = filePath.replace(`${normalizePath(projectPath)}/`, "")
    return {
      ok: true,
      result: { path: relativePath },
      wikiChanged: [{ path: relativePath, operation: "update" }],
    }
  }

  throw new Error(`Unknown app tool: ${toolName}`)
}
