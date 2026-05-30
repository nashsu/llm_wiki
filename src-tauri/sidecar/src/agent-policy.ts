import { createHash } from "node:crypto";

export type AgentPermissionPolicy =
	| "default"
	| "restricted"
	| "bypass"
	| "acceptEdits"
	| "bypassPermissions"
	| "plan"
	| "dontAsk"
	| "auto";

export const READ_WIKI_TOOLS = [
	"mcp__llm_wiki__list_projects",
	"mcp__llm_wiki__list_pages",
	"mcp__llm_wiki__read_page",
	"mcp__llm_wiki__search_pages",
	"mcp__llm_wiki__get_graph",
	"mcp__llm_wiki__build_answer_context",
	"mcp__llm_wiki__run_lint",
	"mcp__llm_wiki__collect_research_sources",
	"mcp__llm_wiki__get_agent_task_status",
	"mcp__llm_wiki__detect_duplicates",
	"mcp__llm_wiki__merge_duplicate_group",
	"mcp__llm_wiki__optimize_research_topic",
	"mcp__llm_wiki__test_provider_connection",
] as const;

export const WRITE_WIKI_TOOLS = [
	"mcp__llm_wiki__update_page",
	"mcp__llm_wiki__create_entity",
	"mcp__llm_wiki__create_concept",
	"mcp__llm_wiki__save_query_page",
	"mcp__llm_wiki__run_deep_research",
	"mcp__llm_wiki__ingest_source",
	"mcp__llm_wiki__caption_source_images",
	"mcp__llm_wiki__fix_lint_result",
	"mcp__llm_wiki__fix_lint_report",
	"mcp__llm_wiki__run_lint_and_report",
	"mcp__llm_wiki__enrich_wikilinks",
	"mcp__llm_wiki__sweep_reviews",
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
	if (policy === "bypass" || policy === "bypassPermissions") {
		return {
			permissionMode: "bypassPermissions" as const,
			allowDangerouslySkipPermissions: true,
		};
	}
	if (
		policy === "acceptEdits" ||
		policy === "plan" ||
		policy === "dontAsk" ||
		policy === "auto"
	) {
		return {
			permissionMode: policy,
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
		"taskId",
		"topic",
		"searchQueries",
		"queries",
		"sourceMode",
		"sourcePath",
		"folderContext",
		"forceRecaption",
		"slugs",
		"canonicalSlug",
		"gapTitle",
		"gapType",
	]) {
		if (source[key] !== undefined) preview[key] = source[key];
	}
	if (source.group && typeof source.group === "object" && !Array.isArray(source.group)) {
		const group = source.group as Record<string, unknown>;
		preview.group = {
			slugs: group.slugs,
			confidence: group.confidence,
		};
	}
	if (typeof source.contents === "string") {
		addTextDigest(preview, "contents", source.contents);
	}
	if (typeof source.overview === "string") {
		addTextDigest(preview, "overview", source.overview);
	}
	if (typeof source.purpose === "string") {
		addTextDigest(preview, "purpose", source.purpose);
	}
	return preview;
}

function addTextDigest(
	preview: Record<string, unknown>,
	key: string,
	value: string,
): void {
	preview[`${key}Bytes`] = Buffer.byteLength(value, "utf8");
	preview[`${key}Sha256`] = createHash("sha256")
		.update(value)
		.digest("hex");
}
