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
	options: { requiresWrite?: boolean } = {},
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
		context.emitAgentEvent?.("agent_task_done", {
			taskId,
			toolName,
			message: `Finished ${toolName}`,
			progress: 1,
			result: data.result ?? raw,
		});
		return jsonResult(data.result ?? raw);
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
