import fs from "node:fs/promises";
import path from "node:path";
import {
	createSdkMcpServer,
	tool,
	type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
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
	operation: "update" | "create";
	oldSha256?: string;
	newSha256: string;
}

export interface LlmWikiToolContext extends WikiApiClientOptions {
	projectPath?: string;
	enableWriteTools?: boolean;
	maxWriteBytes?: number;
	maxFilesChanged?: number;
	fs?: FileSystemLike;
	onWikiChanged?: (payload: WikiChangedPayload) => void;
	changedPaths?: Set<string>;
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
	const changedPaths = args.context.changedPaths ?? new Set<string>();
	args.context.changedPaths = changedPaths;
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
