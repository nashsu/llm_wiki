import { createHash } from "node:crypto";

export type AgentPermissionPolicy = "default" | "restricted" | "bypass";

export const READ_WIKI_TOOLS = [
	"mcp__llm_wiki__list_projects",
	"mcp__llm_wiki__list_pages",
	"mcp__llm_wiki__read_page",
	"mcp__llm_wiki__search_pages",
	"mcp__llm_wiki__get_graph",
	"mcp__llm_wiki__build_answer_context",
	"mcp__llm_wiki__run_lint",
] as const;

export const WRITE_WIKI_TOOLS = [
	"mcp__llm_wiki__update_page",
	"mcp__llm_wiki__create_entity",
	"mcp__llm_wiki__create_concept",
	"mcp__llm_wiki__save_query_page",
	"mcp__llm_wiki__ingest_source",
	"mcp__llm_wiki__caption_source_images",
	"mcp__llm_wiki__fix_lint_result",
	"mcp__llm_wiki__enrich_wikilinks",
] as const;

const WIKI_TOOL_NAMES = new Set<string>([
	...READ_WIKI_TOOLS,
	...WRITE_WIKI_TOOLS,
]);

const WRITE_TOOL_NAMES = new Set<string>(WRITE_WIKI_TOOLS);

export function getAllowedWikiTools(args: {
	wikiToolsEnabled: boolean;
	enableWriteTools: boolean;
}): string[] {
	if (!args.wikiToolsEnabled) return [];
	return [
		...READ_WIKI_TOOLS,
		...(args.enableWriteTools ? WRITE_WIKI_TOOLS : []),
	];
}

export function buildPermissionOptions(policy: AgentPermissionPolicy = "default") {
	if (policy === "restricted") {
		return {
			tools: [] as string[],
			permissionMode: "dontAsk" as const,
		};
	}
	if (policy === "bypass") {
		return {
			permissionMode: "bypassPermissions" as const,
			allowDangerouslySkipPermissions: true,
		};
	}
	return {
		permissionMode: "default" as const,
	};
}

export function isWikiToolName(toolName: string): boolean {
	return WIKI_TOOL_NAMES.has(toolName);
}

export function isWriteWikiToolName(toolName: string): boolean {
	return WRITE_TOOL_NAMES.has(toolName);
}

export function shouldAllowWikiTool(args: {
	toolName: string;
	enableWriteTools: boolean;
}): { allowed: true } | { allowed: false; reason: string } {
	if (!isWikiToolName(args.toolName)) {
		return { allowed: false, reason: "Tool is not an LLM Wiki tool" };
	}
	if (isWriteWikiToolName(args.toolName) && !args.enableWriteTools) {
		return { allowed: false, reason: "Wiki write tools are disabled" };
	}
	return { allowed: true };
}

export function previewToolInput(input: unknown): Record<string, unknown> {
	if (!input || typeof input !== "object" || Array.isArray(input)) return {};
	const source = input as Record<string, unknown>;
	const preview: Record<string, unknown> = {};
	for (const key of [
		"path",
		"root",
		"recursive",
		"maxFiles",
		"query",
		"topK",
		"includeContent",
		"q",
		"limit",
		"name",
		"pathHint",
		"mode",
		"expectedSha256",
		"dryRun",
		"includeSemantic",
		"sourcePath",
		"folderContext",
		"forceRecaption",
	]) {
		if (source[key] !== undefined) preview[key] = source[key];
	}
	if (typeof source.contents === "string") {
		preview.contentsBytes = Buffer.byteLength(source.contents, "utf8");
		preview.contentsSha256 = createHash("sha256")
			.update(source.contents)
			.digest("hex");
	}
	return preview;
}
