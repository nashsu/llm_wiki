import assert from "node:assert/strict";
import test from "node:test";
import {
	buildPermissionOptions,
	getAllowedWikiTools,
	previewToolInput,
	shouldAllowWikiTool,
} from "./agent-policy.js";

test("default permission policy keeps built-in Claude Code tools available", () => {
	assert.deepEqual(buildPermissionOptions("default"), {
		permissionMode: "default",
	});
});

test("restricted permission policy only allows pre-approved tools", () => {
	assert.deepEqual(buildPermissionOptions("restricted"), {
		tools: [],
		permissionMode: "dontAsk",
	});
});

test("bypass permission policy requires explicit dangerous flag", () => {
	assert.deepEqual(buildPermissionOptions("bypass"), {
		permissionMode: "bypassPermissions",
		allowDangerouslySkipPermissions: true,
	});
});

test("allowed Wiki tools follow write mode", () => {
	assert.deepEqual(
		getAllowedWikiTools({ wikiToolsEnabled: false, enableWriteTools: true }),
		[],
	);
	assert.deepEqual(
		getAllowedWikiTools({ wikiToolsEnabled: true, enableWriteTools: false }),
		[
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
		],
	);
	assert.ok(
		getAllowedWikiTools({ wikiToolsEnabled: true, enableWriteTools: true }).includes(
			"mcp__llm_wiki__update_page",
		),
	);
	assert.ok(
		getAllowedWikiTools({ wikiToolsEnabled: true, enableWriteTools: true }).includes(
			"mcp__llm_wiki__ingest_source",
		),
	);
	assert.ok(
		getAllowedWikiTools({ wikiToolsEnabled: true, enableWriteTools: true }).includes(
			"mcp__llm_wiki__run_deep_research",
		),
	);
	assert.ok(
		getAllowedWikiTools({ wikiToolsEnabled: true, enableWriteTools: true }).includes(
			"mcp__llm_wiki__sweep_reviews",
		),
	);
});

test("wiki tool preflight denies non-wiki and disabled write tools", () => {
	assert.deepEqual(
		shouldAllowWikiTool({
			toolName: "Bash",
			enableWriteTools: true,
		}),
		{ allowed: false, reason: "Tool is not an LLM Wiki tool" },
	);
	assert.deepEqual(
		shouldAllowWikiTool({
			toolName: "mcp__llm_wiki__update_page",
			enableWriteTools: false,
		}),
		{ allowed: false, reason: "Wiki write tools are disabled" },
	);
	assert.deepEqual(
		shouldAllowWikiTool({
			toolName: "mcp__llm_wiki__ingest_source",
			enableWriteTools: false,
		}),
		{ allowed: false, reason: "Wiki write tools are disabled" },
	);
	assert.deepEqual(
		shouldAllowWikiTool({
			toolName: "mcp__llm_wiki__run_deep_research",
			enableWriteTools: false,
		}),
		{ allowed: false, reason: "Wiki write tools are disabled" },
	);
	assert.deepEqual(
		shouldAllowWikiTool({
			toolName: "mcp__llm_wiki__sweep_reviews",
			enableWriteTools: false,
		}),
		{ allowed: false, reason: "Wiki write tools are disabled" },
	);
	assert.deepEqual(
		shouldAllowWikiTool({
			toolName: "mcp__llm_wiki__read_page",
			enableWriteTools: false,
		}),
		{ allowed: true },
	);
	assert.deepEqual(
		shouldAllowWikiTool({
			toolName: "mcp__llm_wiki__merge_duplicate_group",
			enableWriteTools: false,
		}),
		{ allowed: true },
	);
});

test("tool input preview omits raw contents", () => {
	const preview = previewToolInput({
		path: "wiki/entities/example.md",
		contents: "hello",
		overview: "# Private overview",
		purpose: "# Private purpose",
		mode: "replace",
	});

	assert.equal(preview.path, "wiki/entities/example.md");
	assert.equal(preview.mode, "replace");
	assert.equal(preview.contents, undefined);
	assert.equal(preview.contentsBytes, 5);
	assert.equal(typeof preview.contentsSha256, "string");
	assert.equal(preview.overview, undefined);
	assert.equal(preview.purpose, undefined);
	assert.equal(preview.overviewBytes, 18);
	assert.equal(preview.purposeBytes, 17);
	assert.equal(typeof preview.overviewSha256, "string");
	assert.equal(typeof preview.purposeSha256, "string");
});
