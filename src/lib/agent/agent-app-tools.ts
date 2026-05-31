import { canonicalizePath, listDirectory, readFile } from "@/commands/fs"
import { buildWikiAnswerContext } from "@/lib/wiki-answer-context"
import { saveQueryPage } from "@/lib/save-query-page"
import { runSemanticLint, runStructuralLint, type LintResult, type LintReport } from "@/lib/lint"
import { fixLintResult, fixLintReport, runLintAndReport } from "@/lib/lint-fixer"
import { lintFixMutex } from "@/lib/lint-fix-mutex"
import { enrichWithWikilinks } from "@/lib/enrich-wikilinks"
import { hasUsableLlm } from "@/lib/has-usable-llm"
import { autoIngest, captionSourceImages } from "@/lib/ingest"
import { collectResearchSources, queueResearch, rewriteAnyTxtQueries } from "@/lib/deep-research"
import { buildDedupLlmCall, executeMerge, loadAllWikiPages, runDuplicateDetection } from "@/lib/dedup-runner"
import { mergeDuplicateGroup, type DuplicateGroup, type MergeResult } from "@/lib/dedup"
import { optimizeResearchTopic } from "@/lib/optimize-research-topic"
import { sweepResolvedReviews } from "@/lib/sweep-reviews"
import { executePipeline, BUILTIN_PIPELINES } from "@/lib/agent/agent-pipeline"
import { runWikiSynthesis } from "@/lib/wiki-synthesis"
import { runAutofill } from "@/lib/agent/agent-autofill"
import { testLlmConnection } from "@/lib/connection-tests"
import { isAbsolutePath, normalizePath } from "@/lib/path-utils"
import { hasConfiguredDeepResearchSources, resolveSearchConfig } from "@/lib/web-search"
import { useResearchStore } from "@/stores/research-store"
import { useReviewStore } from "@/stores/review-store"
import { useWikiStore } from "@/stores/wiki-store"
import type { SearchApiConfig } from "@/stores/wiki-store"
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

function optionalStringArg(args: ToolArgs, key: string): string | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== "string") throw new Error(`${key} must be a string`)
  const clean = value.trim()
  return clean.length > 0 ? clean : undefined
}

function optionalStringArray(args: ToolArgs, key: string): string[] | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${key} must be a string array`)
  }
  return value
}

function optionalNonEmptyStringArray(args: ToolArgs, key: string): string[] | undefined {
  const values = optionalStringArray(args, key)
  if (!values) return undefined
  const clean = values.map((item) => item.trim()).filter(Boolean)
  return clean.length > 0 ? clean : undefined
}

function searchQueriesArg(args: ToolArgs): string[] {
  const queries = optionalNonEmptyStringArray(args, "searchQueries")
    ?? optionalNonEmptyStringArray(args, "queries")
  if (queries) return queries
  const topic = optionalStringArg(args, "topic")
  if (topic) return [topic]
  throw new Error("Provide topic or at least one searchQueries/queries item")
}

function researchRequestArg(args: ToolArgs): { topic: string; searchQueries?: string[] } {
  const topic = optionalStringArg(args, "topic")
  const searchQueries = optionalNonEmptyStringArray(args, "searchQueries")
    ?? optionalNonEmptyStringArray(args, "queries")
  if (!topic && !searchQueries) {
    throw new Error("Provide topic or at least one searchQueries/queries item")
  }
  return {
    topic: topic ?? searchQueries![0],
    searchQueries,
  }
}

function searchConfigWithSourceMode(
  searchConfig: SearchApiConfig,
  sourceMode: unknown,
): SearchApiConfig {
  if (sourceMode === undefined) return searchConfig
  if (sourceMode !== "web" && sourceMode !== "anytxt" && sourceMode !== "both") {
    throw new Error("sourceMode must be web, anytxt, or both")
  }
  return { ...searchConfig, deepResearchSource: sourceMode }
}

function redactConfiguredSecrets(text: string, state: ReturnType<typeof useWikiStore.getState>): string {
  const secrets = [
    state.llmConfig.apiKey,
    state.searchApiConfig.apiKey,
    ...Object.values(state.searchApiConfig.providerConfigs ?? {}).map((config) => config?.apiKey ?? ""),
  ].filter((secret) => secret.length >= 6)

  let redacted = text
  for (const secret of secrets) {
    redacted = redacted.split(secret).join("REDACTED")
  }
  return redacted
}

function redactErrors(errors: string[], state: ReturnType<typeof useWikiStore.getState>): string[] {
  return errors.map((error) => redactConfiguredSecrets(error, state))
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

function duplicateGroupArg(args: ToolArgs): DuplicateGroup {
  const rawGroup = args.group
  const source = rawGroup && typeof rawGroup === "object" && !Array.isArray(rawGroup)
    ? rawGroup as Record<string, unknown>
    : args
  const slugs = Array.isArray(source.slugs)
    ? source.slugs.map((slug) => typeof slug === "string" ? slug.trim() : "").filter(Boolean)
    : []
  if (slugs.length < 2) throw new Error("merge_duplicate_group requires at least two slugs")
  const confidence = source.confidence === "high" || source.confidence === "medium" || source.confidence === "low"
    ? source.confidence
    : "low"
  return {
    slugs,
    reason: typeof source.reason === "string" ? source.reason : "",
    confidence,
  }
}

async function previewDuplicateMerge(
  projectPath: string,
  group: DuplicateGroup,
  canonicalSlug: string,
  llmConfig: ReturnType<typeof useWikiStore.getState>["llmConfig"],
): Promise<MergeResult> {
  const pp = normalizePath(projectPath)
  const allPages = await loadAllWikiPages(pp)
  const pathBySlug = new Map<string, string>()
  for (const page of allPages) {
    const base = page.path.split("/").pop() ?? ""
    if (base.endsWith(".md")) pathBySlug.set(base.slice(0, -3), page.path)
  }
  const groupPages = group.slugs.map((slug) => {
    const relPath = pathBySlug.get(slug)
    if (!relPath) throw new Error(`Slug "${slug}" not found on disk`)
    const page = allPages.find((item) => item.path === relPath)
    if (!page) throw new Error(`Internal: page lookup miss for ${relPath}`)
    return { slug, path: relPath, content: page.content }
  })
  const groupPaths = new Set(groupPages.map((page) => page.path))
  const otherWikiPages = allPages.filter((page) => !groupPaths.has(page.path))
  return mergeDuplicateGroup(
    { group: groupPages, canonicalSlug, otherWikiPages },
    buildDedupLlmCall(llmConfig),
  )
}

function summarizeMergeResult(result: MergeResult, dryRun: boolean): Record<string, unknown> {
  return {
    dryRun,
    canonicalPath: result.canonicalPath,
    canonicalBytes: new TextEncoder().encode(result.canonicalContent).length,
    canonicalPreview: result.canonicalContent.slice(0, 2000),
    rewrites: result.rewrites.map((rewrite) => ({
      path: rewrite.path,
      bytes: new TextEncoder().encode(rewrite.newContent).length,
    })),
    pagesToDelete: result.pagesToDelete,
    backupPaths: result.backup.map((item) => item.path),
  }
}

function mergeWikiChanged(result: MergeResult): AgentWikiChangedPayload[] {
  const updates = [
    result.canonicalPath,
    ...result.rewrites.map((rewrite) => rewrite.path),
  ]
  const uniqueUpdates = [...new Set(updates.filter((path) => path.startsWith("wiki/")))]
  return [
    ...uniqueUpdates.map((path) => ({ path, operation: "update" as const })),
    ...result.pagesToDelete.map((path) => ({ path, operation: "delete" as const })),
  ]
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

  if (toolName === "collect_research_sources") {
    const queries = searchQueriesArg(args)
    const searchConfig = searchConfigWithSourceMode(state.searchApiConfig, args.sourceMode)
    const resolved = resolveSearchConfig(searchConfig)
    if (!hasConfiguredDeepResearchSources(searchConfig)) {
      return {
        ok: true,
        result: {
          queries,
          sourceMode: resolved.deepResearchSource ?? "web",
          results: [],
          errors: ["Deep research source is not configured"],
        },
      }
    }
    const anyTxtQueries = resolved.deepResearchSource === "anytxt" || resolved.deepResearchSource === "both"
      ? await rewriteAnyTxtQueries(queries, state.llmConfig).catch(() => undefined)
      : undefined
    const collected = await collectResearchSources(
      queries,
      searchConfig,
      projectPath,
      undefined,
      { anyTxtQueries },
    )
    return {
      ok: true,
      result: {
        queries,
        anyTxtQueries,
        sourceMode: resolved.deepResearchSource ?? "web",
        results: collected.results,
        errors: redactErrors(collected.errors, state),
      },
    }
  }

  if (toolName === "run_deep_research") {
    const { topic, searchQueries } = researchRequestArg(args)
    const searchConfig = searchConfigWithSourceMode(state.searchApiConfig, args.sourceMode)
    if (!hasConfiguredDeepResearchSources(searchConfig)) {
      return {
        ok: true,
        result: {
          taskId: null,
          status: "error",
          error: "Deep research source is not configured",
        },
      }
    }
    const taskId = queueResearch(
      normalizePath(projectPath),
      topic,
      state.llmConfig,
      searchConfig,
      searchQueries,
    )
    return {
      ok: true,
      result: {
        taskId,
        status: "queued",
        topic,
        searchQueries,
        sourceMode: resolveSearchConfig(searchConfig).deepResearchSource ?? "web",
      },
    }
  }

  if (toolName === "get_agent_task_status") {
    const taskId = stringArg(args, "taskId")
    const task = useResearchStore.getState().tasks.find((item) => item.id === taskId)
    if (!task) {
      return {
        ok: true,
        result: {
          taskId,
          status: "missing",
          error: "Agent task not found",
        },
      }
    }
    return {
      ok: true,
      result: {
        taskId: task.id,
        topic: task.topic,
        status: task.status,
        searchQueries: task.searchQueries,
        sourceCount: task.webResults.length,
        synthesis: task.synthesis,
          savedPath: task.savedPath,
        error: task.error ? redactConfiguredSecrets(task.error, state) : null,
        createdAt: task.createdAt,
      },
    }
  }

  if (toolName === "detect_duplicates") {
    const limit = typeof args.limit === "number" ? Math.max(1, Math.min(50, Math.floor(args.limit))) : 20
    const groups = await runDuplicateDetection(projectPath, state.llmConfig)
    return {
      ok: true,
      result: {
        groups: groups.slice(0, limit),
        totalGroups: groups.length,
      },
    }
  }

  if (toolName === "merge_duplicate_group") {
    const group = duplicateGroupArg(args)
    const canonicalSlug = stringArg(args, "canonicalSlug")
    const dryRun = args.dryRun !== false
    const result = dryRun
      ? await previewDuplicateMerge(projectPath, group, canonicalSlug, state.llmConfig)
      : await executeMerge(projectPath, group, canonicalSlug, state.llmConfig)
    if (!dryRun) {
      state.setFileTree(await listDirectory(projectPath))
      useWikiStore.getState().bumpDataVersion()
    }
    return {
      ok: true,
      result: summarizeMergeResult(result, dryRun),
      wikiChanged: dryRun ? [] : mergeWikiChanged(result),
    }
  }

  if (toolName === "optimize_research_topic") {
    const pp = normalizePath(projectPath)
    const overview = typeof args.overview === "string"
      ? args.overview
      : await readFile(`${pp}/wiki/overview.md`).catch(() => "")
    const purpose = typeof args.purpose === "string"
      ? args.purpose
      : await readFile(`${pp}/purpose.md`).catch(() => "")
    const result = await optimizeResearchTopic(
      state.llmConfig,
      stringArg(args, "gapTitle"),
      typeof args.gapDescription === "string" ? args.gapDescription : "",
      typeof args.gapType === "string" ? args.gapType : "suggestion",
      overview,
      purpose,
    )
    return { ok: true, result }
  }

  if (toolName === "sweep_reviews") {
    const before = useReviewStore.getState().items
    const pendingBefore = before.filter((item) => !item.resolved).length
    const resolvedCount = await sweepResolvedReviews(projectPath)
    const after = useReviewStore.getState().items
    return {
      ok: true,
      result: {
        resolvedCount,
        pendingBefore,
        pendingAfter: after.filter((item) => !item.resolved).length,
        totalReviews: after.length,
      },
    }
  }

  if (toolName === "test_provider_connection") {
    const result = await testLlmConnection(state.llmConfig)
    return {
      ok: true,
      result: {
        ok: result.ok,
        message: redactConfiguredSecrets(result.message, state),
      },
    }
  }

  if (toolName === "ingest_source") {
    const sourcePath = await normalizeSourcePath(projectPath, stringArg(args, "sourcePath"))
    const folderContext = typeof args.folderContext === "string" ? args.folderContext : undefined
    const writtenPaths = await autoIngest(projectPath, sourcePath, state.llmConfig, undefined, folderContext)
    // Run property autofill after ingest completes
    const autofillResult = await runAutofill(projectPath)
    state.setFileTree(await listDirectory(projectPath))
    useWikiStore.getState().bumpDataVersion()
    return {
      ok: true,
      result: {
        sourcePath,
        writtenPaths,
        filesWritten: writtenPaths.length,
        autofill: autofillResult,
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


  // ── Phase 3.65-B: lint report loop ──

  if (toolName === "run_lint_and_report") {
    const fileTree = state.fileTree
    const includeStructural = args.includeStructural !== false
    const includeSemantic = args.includeSemantic === true
    const autoFix = args.autoFix === true
    const { report, reportPath } = await runLintAndReport(projectPath, state.llmConfig, fileTree, includeStructural, includeSemantic, autoFix)
    state.setFileTree(await listDirectory(projectPath))
    useWikiStore.getState().bumpDataVersion()
    return {
      ok: true,
      result: { report, reportPath },
      wikiChanged: [{ path: reportPath, operation: "create" }],
    }
  }

  if (toolName === "fix_lint_report") {
    const release = await lintFixMutex.acquire()
    try {
      const report = args.report as LintReport
      const reportPath = stringArg(args, "reportPath")
      const { report: updatedReport, reportPath: updatedPath } = await fixLintReport(
        projectPath,
        report,
        reportPath,
        state.llmConfig,
      )
      state.setFileTree(await listDirectory(projectPath))
      useWikiStore.getState().bumpDataVersion()
      return {
        ok: true,
        result: { report: updatedReport, reportPath: updatedPath },
        wikiChanged: [{ path: reportPath, operation: "update" }],
      }
    } finally {
      release()
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

  if (toolName === "autofill_properties") {
    const result = await runAutofill(projectPath)
    state.setFileTree(await listDirectory(projectPath))
    useWikiStore.getState().bumpDataVersion()
    return {
      ok: true,
      result,
      wikiChanged: [],
    }
  }

  if (toolName === "run_pipeline") {
    const pipelineName = stringArg(args, "pipeline")
    const schema = BUILTIN_PIPELINES[pipelineName]
    if (!schema) throw new Error(`Unknown pipeline: ${pipelineName}. Available: ${Object.keys(BUILTIN_PIPELINES).join(", ")}`)
    const result = await executePipeline(schema, runAgentAppTool)
    state.setFileTree(await listDirectory(projectPath))
    useWikiStore.getState().bumpDataVersion()
    return {
      ok: true as const,
      result,
      wikiChanged: [],
    }
  }

  if (toolName === "wiki_synthesis") {
    const targetTag = typeof args.targetTag === "string" ? args.targetTag : undefined
    const minClusterSize = typeof args.minClusterSize === "number" ? args.minClusterSize : 3
    const result = await runWikiSynthesis(projectPath, state.llmConfig, state.searchApiConfig, targetTag, minClusterSize)
    if (!result.ok) throw new Error(result.error)
    state.setFileTree(await listDirectory(projectPath))
    useWikiStore.getState().bumpDataVersion()
    return {
      ok: true,
      result,
      wikiChanged: result.synthesisPath ? [{ path: result.synthesisPath, operation: "create" as const }] : [],
    }
  }

  throw new Error(`Unknown app tool: ${toolName}`)
}
