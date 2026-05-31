import fs from "node:fs/promises";
import path from "node:path";
import {
	createSdkMcpServer,
	tool,
	type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AppToolBridge } from "./app-tool-bridge.js";
import { createWikiApiClient, type WikiApiClientOptions } from "./wiki-api.js";
import {
	assertFixedDirectoryPath,
	assertWikiMarkdownPath,
	assertWritableContents,
	buildConceptMarkdown,
	buildEntityMarkdown,
	defaultConceptPath,
	defaultEntityPath,
	diffSummary,
	type FileSystemLike,
	pathExists,
	resolveWritePlan,
	sha256,
} from "./wiki-paths.js";

const DEFAULT_MAX_WRITE_BYTES = 256 * 1024;
const DEFAULT_MAX_FILES_CHANGED = 3;
const STRING_ARRAY = z.array(z.string());
const SOURCE_MODE_SCHEMA = z.enum(["web", "anytxt", "both"]);
const RESEARCH_SEED_ERROR = "Provide topic or at least one searchQueries/queries item";
const DUPLICATE_MERGE_SEED_ERROR = "Provide duplicate group.slugs or slugs with at least two page slugs";

export interface WikiChangedPayload {
	path: string;
	operation: "update" | "create" | "delete";
	oldSha256?: string;
	newSha256?: string;
}

interface AppToolResult {
	ok?: boolean;
	result?: unknown;
	changedPaths?: string[];
	wikiChanged?: WikiChangedPayload[];
}

export interface LlmWikiToolContext extends WikiApiClientOptions {
	projectPath?: string;
	enableWriteTools?: boolean;
	maxWriteBytes?: number;
	maxFilesChanged?: number;
	fs?: FileSystemLike;
	onWikiChanged?: (payload: WikiChangedPayload) => void;
	changedPaths?: Set<string>;
	streamId?: string;
	appToolBridge?: AppToolBridge;
	emitAgentEvent?: (type: string, data: unknown) => void;
}

function jsonResult(data: unknown, isError = false): CallToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
		structuredContent: typeof data === "object" && data !== null ? (data as Record<string, unknown>) : { value: data },
		...(isError ? { isError: true } : {}),
	};
}

function resourceResult(data: Record<string, unknown>, uri: string, text: string): CallToolResult {
	return {
		content: [
			{ type: "text", text: JSON.stringify(data, null, 2) },
			{
				type: "resource",
				resource: {
					uri,
					mimeType: "text/markdown",
					text,
				},
			},
		],
		structuredContent: data,
	};
}

async function safe(handler: () => Promise<CallToolResult>): Promise<CallToolResult> {
	try {
		return await handler();
	} catch (err) {
		return jsonResult(
			{
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			},
			true,
		);
	}
}

async function appTool(
	context: LlmWikiToolContext,
	toolName: string,
	args: Record<string, unknown>,
	options: { requiresWrite?: boolean; includeTaskId?: boolean } = {},
): Promise<CallToolResult> {
	if (!context.streamId) throw new Error("streamId is required for app tools");
	if (!context.appToolBridge) throw new Error("App tool bridge is not available");
	if (options.requiresWrite && context.enableWriteTools === false) {
		throw new Error("Wiki write tools are disabled for this request");
	}

	const taskId = `${toolName}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	context.emitAgentEvent?.("agent_task_started", {
		taskId,
		toolName,
		message: `Starting ${toolName}`,
	});
	context.emitAgentEvent?.("agent_task_progress", {
		taskId,
		toolName,
		message: "Waiting for LLM Wiki app service",
	});

	try {
		const raw = await context.appToolBridge.callTool(context.streamId, toolName, args);
		const data = normalizeAppToolResult(raw);
		for (const changed of data.wikiChanged ?? []) {
			context.changedPaths?.add(changed.path);
			context.onWikiChanged?.(changed);
		}
		for (const changedPath of data.changedPaths ?? []) {
			context.changedPaths?.add(changedPath);
			context.onWikiChanged?.({
				path: changedPath,
				operation: "update",
			});
		}
		const toolResult = data.result ?? raw;
		const resultPayload = options.includeTaskId && toolResult && typeof toolResult === "object" && !Array.isArray(toolResult)
			? { taskId, ...(toolResult as Record<string, unknown>) }
			: toolResult;
		context.emitAgentEvent?.("agent_task_done", {
			taskId,
			toolName,
			message: `Finished ${toolName}`,
			progress: 1,
			result: resultPayload,
		});
		return jsonResult(resultPayload);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		context.emitAgentEvent?.("agent_task_error", {
			taskId,
			toolName,
			error: message,
		});
		return jsonResult({ ok: false, error: message }, true);
	}
}

function normalizeAppToolResult(raw: unknown): AppToolResult {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("App tool returned an invalid response");
	}
	const data = raw as Record<string, unknown>;
	return {
		ok: typeof data.ok === "boolean" ? data.ok : undefined,
		result: data.result ?? raw,
		changedPaths: parseChangedPaths(data.changedPaths),
		wikiChanged: parseWikiChanged(data.wikiChanged),
	};
}

function parseChangedPaths(value: unknown): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("changedPaths must be an array");
	return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function parseWikiChanged(value: unknown): WikiChangedPayload[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("wikiChanged must be an array");
	const allowedOperations = new Set(["update", "create", "delete"]);
	return value.flatMap((item): WikiChangedPayload[] => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return [];
		const record = item as Record<string, unknown>;
		if (
			typeof record.path !== "string" ||
			!allowedOperations.has(String(record.operation))
		) {
			return [];
		}
		return [
			{
				path: record.path,
				operation: record.operation as WikiChangedPayload["operation"],
				...(typeof record.oldSha256 === "string" ? { oldSha256: record.oldSha256 } : {}),
				...(typeof record.newSha256 === "string" ? { newSha256: record.newSha256 } : {}),
			},
		];
	});
}

function hasNonEmptyString(value: unknown): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

function hasNonEmptyStringArray(value: unknown): boolean {
	return Array.isArray(value) && value.some((item) => hasNonEmptyString(item));
}

function hasAtLeastTwoNonEmptyStrings(value: unknown): boolean {
	return Array.isArray(value) && value.filter((item) => hasNonEmptyString(item)).length >= 2;
}

function assertResearchSeed(args: Record<string, unknown>): void {
	if (
		hasNonEmptyString(args.topic) ||
		hasNonEmptyStringArray(args.searchQueries) ||
		hasNonEmptyStringArray(args.queries)
	) {
		return;
	}
	throw new Error(RESEARCH_SEED_ERROR);
}

function assertDuplicateMergeSeed(args: Record<string, unknown>): void {
	if (hasAtLeastTwoNonEmptyStrings(args.slugs)) return;
	const group = args.group;
	if (group && typeof group === "object" && !Array.isArray(group)) {
		if (hasAtLeastTwoNonEmptyStrings((group as Record<string, unknown>).slugs)) return;
	}
	throw new Error(DUPLICATE_MERGE_SEED_ERROR);
}

const RESEARCH_TOPIC_FIELD = z.string().min(1)
	.describe("Research topic. Required when searchQueries/queries is omitted.");
const RESEARCH_QUERIES_FIELD = STRING_ARRAY
	.describe("Specific search queries. Empty items are ignored when topic is present.");
const RESEARCH_QUERIES_REQUIRED_FIELD = z.array(z.string().min(1)).min(1)
	.describe("Specific search queries. Required when topic is omitted.");
const RESEARCH_QUERY_ALIAS_FIELD = STRING_ARRAY
	.describe("Alias for searchQueries. Empty items are ignored when topic/searchQueries is present.");
const RESEARCH_QUERY_ALIAS_REQUIRED_FIELD = z.array(z.string().min(1)).min(1)
	.describe("Alias for searchQueries. Required when topic/searchQueries is omitted.");

const researchSeedObjectSchema = z.union([
	z.object({
		topic: RESEARCH_TOPIC_FIELD,
		searchQueries: RESEARCH_QUERIES_FIELD.optional(),
		queries: RESEARCH_QUERY_ALIAS_FIELD.optional(),
		sourceMode: SOURCE_MODE_SCHEMA.optional(),
	}),
	z.object({
		topic: RESEARCH_TOPIC_FIELD.optional(),
		searchQueries: RESEARCH_QUERIES_REQUIRED_FIELD,
		queries: RESEARCH_QUERY_ALIAS_FIELD.optional(),
		sourceMode: SOURCE_MODE_SCHEMA.optional(),
	}),
	z.object({
		topic: RESEARCH_TOPIC_FIELD.optional(),
		searchQueries: RESEARCH_QUERIES_FIELD.optional(),
		queries: RESEARCH_QUERY_ALIAS_REQUIRED_FIELD,
		sourceMode: SOURCE_MODE_SCHEMA.optional(),
	}),
]);

const DUPLICATE_GROUP_FIELD = z.object({
	slugs: z.array(z.string().min(1)).min(2),
	reason: z.string().optional(),
	confidence: z.enum(["high", "medium", "low"]).optional(),
}).describe("Duplicate group returned by detect_duplicates. Required when slugs is omitted.");
const DUPLICATE_SLUGS_FIELD = z.array(z.string().min(1)).min(2)
	.describe("Duplicate page slugs. Required when group is omitted.");

const duplicateMergeObjectSchema = z.union([
	z.object({
		group: DUPLICATE_GROUP_FIELD,
		slugs: DUPLICATE_SLUGS_FIELD.optional(),
		canonicalSlug: z.string().min(1),
		dryRun: z.boolean().optional(),
	}),
	z.object({
		group: DUPLICATE_GROUP_FIELD.optional(),
		slugs: DUPLICATE_SLUGS_FIELD,
		canonicalSlug: z.string().min(1),
		dryRun: z.boolean().optional(),
	}),
]);

function appMcpTool<Schema extends z.ZodTypeAny>(
	name: string,
	description: string,
	inputSchema: Schema,
	handler: (args: z.infer<Schema>) => Promise<CallToolResult>,
): SdkMcpToolDefinition<any> {
	return {
		name,
		description,
		inputSchema,
		handler: (args) => handler(args as z.infer<Schema>),
	};
}

async function readExisting(fsLike: FileSystemLike, absolutePath: string): Promise<string> {
	return fsLike.readFile(absolutePath, "utf8");
}

async function writePage(args: {
	context: LlmWikiToolContext;
	relativePath: string;
	contents: string;
	mode: "replace" | "append";
	expectedSha256?: string;
	dryRun?: boolean;
	operation: "update" | "create";
	mustExist: boolean;
	fixedDirectory?: "entities" | "concepts";
}): Promise<CallToolResult> {
	const fsLike = args.context.fs ?? fs;
	const projectPath = args.context.projectPath;
	if (!projectPath) throw new Error("projectPath is required for write tools");
	if (args.context.enableWriteTools === false && !args.dryRun) {
		throw new Error("Write tools are disabled for this request");
	}

	const maxWriteBytes = args.context.maxWriteBytes ?? DEFAULT_MAX_WRITE_BYTES;
	const relativePath = args.fixedDirectory
		? assertFixedDirectoryPath(args.relativePath, args.fixedDirectory)
		: assertWikiMarkdownPath(args.relativePath);

	await fsLike.mkdir(path.join(projectPath, "wiki"), { recursive: true });
	if (args.fixedDirectory) {
		await fsLike.mkdir(path.join(projectPath, "wiki", args.fixedDirectory), { recursive: true });
	}

	const plan = await resolveWritePlan(fsLike, projectPath, relativePath);
	const exists = await pathExists(fsLike, plan.absolutePath);
	if (args.mustExist && !exists) throw new Error(`File does not exist: ${plan.relativePath}`);
	if (!args.mustExist && exists) throw new Error(`File already exists: ${plan.relativePath}`);

	const oldText = exists ? await readExisting(fsLike, plan.absolutePath) : "";
	const oldSha256 = exists ? sha256(oldText) : undefined;
	if (args.expectedSha256 && oldSha256 !== args.expectedSha256) {
		throw new Error("expectedSha256 does not match current file");
	}

	const newText = args.mode === "append" && exists ? `${oldText.trimEnd()}\n\n${args.contents.trim()}\n` : args.contents;
	assertWritableContents(newText, maxWriteBytes);
	const newSha256 = sha256(newText);
	const summary = diffSummary(oldText, newText);

	const payload = {
		ok: true,
		dryRun: args.dryRun === true,
		path: plan.relativePath,
		operation: args.operation,
		oldSha256,
		newSha256,
		diffSummary: JSON.parse(summary) as Record<string, unknown>,
	};

	if (args.dryRun) return jsonResult(payload);

	const maxFilesChanged = args.context.maxFilesChanged ?? DEFAULT_MAX_FILES_CHANGED;
	const changedPaths = (args.context.changedPaths =
		args.context.changedPaths ?? new Set<string>());
	if (!changedPaths.has(plan.relativePath) && changedPaths.size >= maxFilesChanged) {
		throw new Error(`Write would exceed maxFilesChanged (${maxFilesChanged})`);
	}

	await fsLike.writeFile(plan.absolutePath, newText, "utf8");
	changedPaths.add(plan.relativePath);
	args.context.onWikiChanged?.({
		path: plan.relativePath,
		operation: args.operation,
		oldSha256,
		newSha256,
	});
	return jsonResult(payload);
}

export function createLlmWikiTools(
	context: LlmWikiToolContext,
): Array<SdkMcpToolDefinition<any>> {
	const api = createWikiApiClient({
		baseUrl: context.baseUrl,
		token: context.token,
		projectId: context.projectId,
		fetchFn: context.fetchFn,
	});

	return [
		tool("list_projects", "List LLM Wiki projects and the current project.", {}, async () =>
			safe(async () => jsonResult(await api.listProjects())),
		),
		tool(
			"list_pages",
			"List project files exposed by LLM Wiki.",
			{
				root: z.enum(["wiki", "sources", "all"]).optional(),
				recursive: z.boolean().optional(),
				maxFiles: z.number().int().positive().optional(),
			},
			async (args) => safe(async () => jsonResult(await api.listPages(args))),
		),
		tool(
			"read_page",
			"Read a public text file from the current LLM Wiki project.",
			{
				path: z.string().min(1),
			},
			async (args) =>
				safe(async () => {
					const data = (await api.readPage(args.path)) as Record<string, unknown>;
					const content = typeof data.content === "string" ? data.content : "";
					return resourceResult(data, `llm-wiki://current/${args.path}`, content);
				}),
		),
		tool(
			"search_pages",
			"Search the current Wiki using LLM Wiki hybrid retrieval.",
			{
				query: z.string().min(1),
				topK: z.number().int().positive().optional(),
				includeContent: z.boolean().optional(),
			},
			async (args) => safe(async () => jsonResult(await api.searchPages(args))),
		),
		tool(
			"get_graph",
			"Return Wiki graph nodes and edges.",
			{
				q: z.string().optional(),
				limit: z.number().int().positive().optional(),
			},
			async (args) => safe(async () => jsonResult(await api.getGraph(args))),
		),
		tool(
			"build_answer_context",
			"Build the same deterministic Wiki RAG context used by normal Chat.",
			{
				query: z.string().min(1),
				maxContextSize: z.number().int().positive().optional(),
			},
			async (args) => safe(async () => appTool(context, "build_answer_context", args)),
		),
		tool(
			"save_query_page",
			"Save text as a Wiki query page using LLM Wiki's canonical Save-to-Wiki rules.",
			{
				content: z.string().min(1),
				title: z.string().optional(),
				tags: z.array(z.string()).optional(),
				autoIngest: z.boolean().optional(),
			},
			async (args) =>
				safe(async () =>
					appTool(context, "save_query_page", args, { requiresWrite: true }),
				),
		),
		tool(
			"run_lint",
			"Run LLM Wiki lint checks on the active Wiki.",
			{
				includeStructural: z.boolean().optional(),
				includeSemantic: z.boolean().optional(),
			},
			async (args) => safe(async () => appTool(context, "run_lint", args)),
		),
		appMcpTool(
			"collect_research_sources",
			"Collect Deep Research sources using LLM Wiki's configured Web Search and/or AnyTXT providers without exposing API keys. Provide topic or at least one searchQueries/queries item.",
			researchSeedObjectSchema,
			async (args) =>
				safe(async () => {
					assertResearchSeed(args);
					return appTool(context, "collect_research_sources", args);
				}),
		),
		appMcpTool(
			"run_deep_research",
			"Queue LLM Wiki's Deep Research workflow. Provide topic or at least one searchQueries/queries item. Tool completion means queued, not finished; poll get_agent_task_status for progress and savedPath.",
			researchSeedObjectSchema,
			async (args) =>
				safe(async () => {
					assertResearchSeed(args);
					return appTool(context, "run_deep_research", args, {
						requiresWrite: true,
						includeTaskId: true,
					});
				}),
		),
		tool(
			"get_agent_task_status",
			"Return status for an app-level Agent task such as Deep Research.",
			{
				taskId: z.string().min(1),
			},
			async (args) => safe(async () => appTool(context, "get_agent_task_status", args)),
		),
		tool(
			"detect_duplicates",
			"Detect duplicate entity/concept pages using LLM Wiki's existing dedup workflow.",
			{
				limit: z.number().int().positive().optional(),
			},
			async (args) => safe(async () => appTool(context, "detect_duplicates", args)),
		),
		appMcpTool(
			"merge_duplicate_group",
			"Preview or execute LLM Wiki's duplicate-page merge. Defaults to dryRun=true; only dryRun=false writes files and requires write tools enabled.",
			duplicateMergeObjectSchema,
			async (args) =>
				safe(async () => {
					assertDuplicateMergeSeed(args);
					return appTool(context, "merge_duplicate_group", args, {
						requiresWrite: args.dryRun === false,
						includeTaskId: true,
					});
				}),
		),
		tool(
			"optimize_research_topic",
			"Generate a context-aware research topic and search queries for a review/gap item.",
			{
				gapTitle: z.string().min(1),
				gapDescription: z.string().optional(),
				gapType: z.string().optional(),
				overview: z.string().optional(),
				purpose: z.string().optional(),
			},
			async (args) => safe(async () => appTool(context, "optimize_research_topic", args)),
		),
		tool(
			"sweep_reviews",
			"Run LLM Wiki's review cleanup and resolve stale review items when the current wiki state addresses them.",
			{},
			async (args) =>
				safe(async () =>
					appTool(context, "sweep_reviews", args, {
						requiresWrite: true,
						includeTaskId: true,
					}),
				),
		),
		tool(
			"test_provider_connection",
			"Test the active LLM provider connection using LLM Wiki's existing provider test.",
			{},
			async (args) => safe(async () => appTool(context, "test_provider_connection", args)),
		),
		tool(
			"ingest_source",
			"Run LLM Wiki's full auto-ingest pipeline for one raw source, including cache, merge, review items, and image captioning when enabled.",
			{
				sourcePath: z.string().min(1),
				folderContext: z.string().optional(),
			},
			async (args) =>
				safe(async () =>
					appTool(context, "ingest_source", args, {
						requiresWrite: true,
						includeTaskId: true,
					}),
				),
		),
		tool(
			"caption_source_images",
			"Extract and caption embedded images for one raw source, then inject the image section into its source summary.",
			{
				sourcePath: z.string().min(1),
				forceRecaption: z.boolean().optional(),
			},
			async (args) =>
				safe(async () =>
					appTool(context, "caption_source_images", args, {
						requiresWrite: true,
						includeTaskId: true,
					}),
				),
		),
		tool(
			"fix_lint_result",
			"Apply LLM Wiki's existing fixer to one lint result.",
			{
				result: z.object({
					type: z.enum(["orphan", "broken-link", "no-outlinks", "semantic"]),
					severity: z.enum(["warning", "info"]),
					page: z.string().min(1),
					detail: z.string(),
					affectedPages: z.array(z.string()).optional(),
				}),
			},
			async (args) =>
				safe(async () =>
					appTool(context, "fix_lint_result", args, { requiresWrite: true }),
				),
		),
		tool(
			"run_lint_and_report",
			"Run structural + semantic lint, generate a structured report page with health score, auto-fix/human split, and save to wiki. Set autoFix=true to automatically fix all auto-fix items after generating the report.",
			{
				includeStructural: z.boolean().optional(),
				includeSemantic: z.boolean().optional(),
				autoFix: z.boolean().optional(),
			},
			async (args) =>
				safe(async () =>
					appTool(context, "run_lint_and_report", args, { requiresWrite: true }),
				),
		),
		tool(
			"fix_lint_report",
			"Auto-fix all auto-fix items in a lint report and append a repair log.",
			{
				report: z.object({ healthScore: z.number(), autoFixItems: z.array(z.object({}).passthrough()), humanItems: z.array(z.object({}).passthrough()), }).passthrough(),
				reportPath: z.string().min(1),
			},
			async (args) =>
				safe(async () =>
					appTool(context, "fix_lint_report", args, { requiresWrite: true }),
				),
		),

		tool(
			"autofill_properties",
			"Scan wiki concept/entity pages and automatically fill missing Status and Tags frontmatter fields. Status promotion: Draft + 7 days + content complete → Under Review; referenced by ≥2 summaries → Reviewed. Tags: empty → extract 1-3 keywords from title and headings.",
			{},
			async (args) =>
				safe(async () =>
					appTool(context, "autofill_properties", args, { requiresWrite: true }),
				),
		),

		tool(
			"run_pipeline",
			"Execute a built-in multi-agent pipeline by name. Available pipelines: full-ingest (compile→lint→fix), lint-fix (lint→fix). Returns step-by-step results with timing.",
			{
				pipeline: z.string().min(1),
			},
			async (args) =>
				safe(async () =>
					appTool(context, "run_pipeline", args, { requiresWrite: true }),
				),
		),

		tool(
			"enrich_wikilinks",
			"Add safe wikilinks to one Wiki page using LLM Wiki's enrichment pipeline.",
			{
				path: z.string().min(1),
			},
			async (args) =>
				safe(async () =>
					appTool(context, "enrich_wikilinks", args, { requiresWrite: true }),
				),
		),
		tool(
			"update_page",
			"Replace or append to an existing Wiki Markdown page.",
			{
				path: z.string().min(1),
				contents: z.string().min(1),
				mode: z.enum(["replace", "append"]).optional(),
				expectedSha256: z.string().optional(),
				dryRun: z.boolean().optional(),
			},
			async (args) =>
				safe(async () =>
					writePage({
						context,
						relativePath: args.path,
						contents: args.contents,
						mode: args.mode ?? "replace",
						expectedSha256: args.expectedSha256,
						dryRun: args.dryRun,
						operation: "update",
						mustExist: true,
					}),
				),
		),
		tool(
			"create_entity",
			"Create a new Wiki entity page.",
			{
				name: z.string().min(1),
				summary: z.string().min(1),
				aliases: z.array(z.string()).optional(),
				sources: z.array(z.string()).optional(),
				pathHint: z.string().optional(),
				dryRun: z.boolean().optional(),
			},
			async (args) =>
				safe(async () =>
					writePage({
						context,
						relativePath: args.pathHint ?? defaultEntityPath(args.name),
						contents: buildEntityMarkdown(args),
						mode: "replace",
						dryRun: args.dryRun,
						operation: "create",
						mustExist: false,
						fixedDirectory: "entities",
					}),
				),
		),
		tool(
			"create_concept",
			"Create a new Wiki concept page.",
			{
				name: z.string().min(1),
				explanation: z.string().min(1),
				related: z.array(z.string()).optional(),
				sources: z.array(z.string()).optional(),
				pathHint: z.string().optional(),
				dryRun: z.boolean().optional(),
			},
			async (args) =>
				safe(async () =>
					writePage({
						context,
						relativePath: args.pathHint ?? defaultConceptPath(args.name),
						contents: buildConceptMarkdown(args),
						mode: "replace",
						dryRun: args.dryRun,
						operation: "create",
						mustExist: false,
						fixedDirectory: "concepts",
					}),
				),
		),
	] as Array<SdkMcpToolDefinition<any>>;
}

export function createLlmWikiMcpServer(context: LlmWikiToolContext) {
	return createSdkMcpServer({
		name: "llm_wiki",
		version: "0.1.0",
		instructions:
			"Use these tools to read, search, inspect, and update the active LLM Wiki project. Write tools may only modify wiki Markdown pages.",
		tools: createLlmWikiTools(context),
	});
}
