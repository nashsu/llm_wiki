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
		],
	);
	assert.ok(
		getAllowedWikiTools({ wikiToolsEnabled: true, enableWriteTools: true }).includes(
			"mcp__llm_wiki__update_page",
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
			toolName: "mcp__llm_wiki__read_page",
			enableWriteTools: false,
		}),
		{ allowed: true },
	);
});

test("tool input preview omits raw contents", () => {
	const preview = previewToolInput({
		path: "wiki/entities/example.md",
		contents: "hello",
		mode: "replace",
	});

	assert.equal(preview.path, "wiki/entities/example.md");
	assert.equal(preview.mode, "replace");
	assert.equal(preview.contents, undefined);
	assert.equal(preview.contentsBytes, 5);
	assert.equal(typeof preview.contentsSha256, "string");
});
