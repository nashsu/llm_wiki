import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { assertWikiMarkdownPath } from "./wiki-paths.js";
import { createLlmWikiTools, type WikiChangedPayload } from "./wiki-tools.js";

function toolByName(name: string, context: Parameters<typeof createLlmWikiTools>[0]) {
	const found = createLlmWikiTools(context).find((item) => item.name === name);
	assert.ok(found, `missing tool ${name}`);
	return found;
}

function resultText(result: CallToolResult): string {
	const first = result.content[0];
	assert.equal(first?.type, "text");
	return first.text;
}

async function tempProject(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "llm-wiki-agent-tools-"));
	await fs.mkdir(path.join(dir, "wiki", "entities"), { recursive: true });
	await fs.mkdir(path.join(dir, "wiki", "concepts"), { recursive: true });
	await fs.writeFile(path.join(dir, "wiki", "index.md"), "# Index\n\nThis is a useful page.\n", "utf8");
	return dir;
}

test("wiki markdown paths decode URI encoding before validation", () => {
	assert.equal(
		assertWikiMarkdownPath("wiki/entities%2Fencoded.md"),
		"wiki/entities/encoded.md",
	);
	assert.throws(
		() => assertWikiMarkdownPath("wiki%2F..%2Fsecret.md"),
		/safe project-relative path/,
	);
	assert.throws(
		() => assertWikiMarkdownPath("wiki/%E0%A4%A.md"),
		/invalid URI encoding/,
	);
});

test("search_pages calls local API with auth and clamped topK", async () => {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const search = toolByName("search_pages", {
		baseUrl: "http://127.0.0.1:19828",
		token: "secret-token",
		fetchFn: async (url, init) => {
			calls.push({ url: String(url), init });
			return new Response(JSON.stringify({ ok: true, results: [] }));
		},
	});

	const result = await search.handler({ query: "graph", topK: 999, includeContent: true }, {});

	assert.equal(result.isError, undefined);
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.url, "http://127.0.0.1:19828/api/v1/projects/current/search");
	assert.equal(calls[0]?.init?.method, "POST");
	assert.equal((calls[0]?.init?.headers as Record<string, string>).Authorization, "Bearer secret-token");
	assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
		query: "graph",
		topK: 20,
		includeContent: true,
	});
});

test("read_page url-encodes path and returns resource content", async () => {
	const calls: string[] = [];
	const readPage = toolByName("read_page", {
		fetchFn: async (url) => {
			calls.push(String(url));
			return new Response(
				JSON.stringify({ ok: true, path: "wiki/hello world.md", content: "# Hello" }),
			);
		},
	});

	const result = await readPage.handler({ path: "wiki/hello world.md" }, {});

	assert.equal(calls[0], "http://127.0.0.1:19828/api/v1/projects/current/files/content?path=wiki%2Fhello+world.md");
	assert.equal(result.content[1]?.type, "resource");
	assert.match(resultText(result), /hello world/);
});

test("API errors are returned as tool errors without leaking token", async () => {
	const list = toolByName("list_projects", {
		token: "secret-token",
		fetchFn: async () =>
			new Response(JSON.stringify({ ok: false, error: "bad secret-token" }), {
				status: 401,
			}),
	});

	const result = await list.handler({}, {});

	assert.equal(result.isError, true);
	assert.doesNotMatch(resultText(result), /secret-token/);
	assert.match(resultText(result), /REDACTED/);
});

test("update_page writes wiki markdown and emits changed payload", async () => {
	const projectPath = await tempProject();
	const changed: WikiChangedPayload[] = [];
	const update = toolByName("update_page", {
		projectPath,
		onWikiChanged: (payload) => changed.push(payload),
	});

	const result = await update.handler(
		{
			path: "wiki/index.md",
			contents: "# Index\n\nThis page was updated by Agent.\n",
		},
		{},
	);

	const written = await fs.readFile(path.join(projectPath, "wiki", "index.md"), "utf8");
	assert.match(written, /updated by Agent/);
	assert.equal(result.isError, undefined);
	assert.equal(changed.length, 1);
	assert.equal(changed[0]?.path, "wiki/index.md");
	assert.equal(changed[0]?.operation, "update");
	assert.match(resultText(result), /newSha256/);
});

test("update_page dryRun does not write", async () => {
	const projectPath = await tempProject();
	const update = toolByName("update_page", { projectPath });

	const result = await update.handler(
		{
			path: "wiki/index.md",
			contents: "# Index\n\nDry run content should not persist.\n",
			dryRun: true,
		},
		{},
	);

	const written = await fs.readFile(path.join(projectPath, "wiki", "index.md"), "utf8");
	assert.doesNotMatch(written, /Dry run content/);
	assert.match(resultText(result), /"dryRun": true/);
});

test("update_page rejects unsafe and oversized writes", async () => {
	const projectPath = await tempProject();
	const update = toolByName("update_page", {
		projectPath,
		maxWriteBytes: 30,
	});

	const rawResult = await update.handler(
		{ path: "raw/sources/source.md", contents: "# Source\n\nNot allowed." },
		{},
	);
	const absoluteResult = await update.handler(
		{ path: "/wiki/index.md", contents: "# Index\n\nAbsolute paths are not allowed." },
		{},
	);
	const bigResult = await update.handler(
		{ path: "wiki/index.md", contents: "# Index\n\nThis content is deliberately too large." },
		{},
	);

	assert.equal(rawResult.isError, true);
	assert.match(resultText(rawResult), /wiki/);
	assert.equal(absoluteResult.isError, true);
	assert.match(resultText(absoluteResult), /safe project-relative path/);
	assert.equal(bigResult.isError, true);
	assert.match(resultText(bigResult), /maxWriteBytes/);
});

test("update_page rejects real writes when write tools are disabled", async () => {
	const projectPath = await tempProject();
	const update = toolByName("update_page", {
		projectPath,
		enableWriteTools: false,
	});

	const rejected = await update.handler(
		{
			path: "wiki/index.md",
			contents: "# Index\n\nThis real write should be rejected.",
		},
		{},
	);
	const dryRun = await update.handler(
		{
			path: "wiki/index.md",
			contents: "# Index\n\nDry run is still allowed while writes are disabled.",
			dryRun: true,
		},
		{},
	);

	assert.equal(rejected.isError, true);
	assert.match(resultText(rejected), /disabled/);
	assert.equal(dryRun.isError, undefined);
	assert.match(resultText(dryRun), /"dryRun": true/);
});

test("write tools enforce maxFilesChanged per tool context", async () => {
	const projectPath = await tempProject();
	const context = {
		projectPath,
		maxFilesChanged: 1,
	};
	const update = toolByName("update_page", context);
	const createEntity = toolByName("create_entity", context);

	const first = await update.handler(
		{
			path: "wiki/index.md",
			contents: "# Index\n\nFirst write should be allowed.",
		},
		{},
	);
	const second = await createEntity.handler(
		{
			name: "Second File",
			summary: "This second file should exceed the write limit.",
		},
		{},
	);

	assert.equal(first.isError, undefined);
	assert.equal(second.isError, true);
	assert.match(resultText(second), /maxFilesChanged/);
});

test("create_entity writes fixed directory and refuses overwrite", async () => {
	const projectPath = await tempProject();
	const createEntity = toolByName("create_entity", { projectPath });

	const created = await createEntity.handler(
		{ name: "Knowledge Graph", summary: "A graph of wiki concepts and links." },
		{},
	);
	const duplicate = await createEntity.handler(
		{ name: "Knowledge Graph", summary: "Second version should not overwrite." },
		{},
	);

	const rel = path.join("wiki", "entities", "knowledge-graph.md");
	const written = await fs.readFile(path.join(projectPath, rel), "utf8");
	assert.equal(created.isError, undefined);
	assert.match(written, /Knowledge Graph/);
	assert.equal(duplicate.isError, true);
	assert.match(resultText(duplicate), /already exists/);
});

test("app-level tools call bridge and emit wiki change/task events", async () => {
	const sent: Array<{ type: string; data: unknown }> = [];
	const bridgeCalls: Array<{ streamId: string; toolName: string; args: Record<string, unknown> }> = [];
	const changed: WikiChangedPayload[] = [];
	const save = toolByName("save_query_page", {
		streamId: "stream-1",
		emitAgentEvent: (type, data) => sent.push({ type, data }),
		onWikiChanged: (payload) => changed.push(payload),
		appToolBridge: {
			async callTool(streamId, toolName, args) {
				bridgeCalls.push({ streamId, toolName, args });
				return {
					ok: true,
					result: { relativePath: "wiki/queries/saved.md" },
					wikiChanged: [{ path: "wiki/queries/saved.md", operation: "create" }],
				};
			},
			handleResponse() {},
			rejectStream() {},
		},
	});

	const result = await save.handler({ content: "Saved answer", title: "Saved" }, {});

	assert.equal(result.isError, undefined);
	assert.deepEqual(bridgeCalls, [
		{
			streamId: "stream-1",
			toolName: "save_query_page",
			args: { content: "Saved answer", title: "Saved" },
		},
	]);
	assert.deepEqual(changed, [{ path: "wiki/queries/saved.md", operation: "create" }]);
	assert.deepEqual(sent.map((event) => event.type), [
		"agent_task_started",
		"agent_task_progress",
		"agent_task_done",
	]);
	assert.match(resultText(result), /wiki\/queries\/saved.md/);
});

test("ingest_source calls app bridge as write tool and returns task id", async () => {
	const sent: Array<{ type: string; data: unknown }> = [];
	const bridgeCalls: Array<{ streamId: string; toolName: string; args: Record<string, unknown> }> = [];
	const changed: WikiChangedPayload[] = [];
	const ingest = toolByName("ingest_source", {
		streamId: "stream-1",
		enableWriteTools: true,
		emitAgentEvent: (type, data) => sent.push({ type, data }),
		onWikiChanged: (payload) => changed.push(payload),
		appToolBridge: {
			async callTool(streamId, toolName, args) {
				bridgeCalls.push({ streamId, toolName, args });
				return {
					ok: true,
					result: { sourcePath: "/project/raw/sources/source.pdf", writtenPaths: ["wiki/sources/source.md"] },
					wikiChanged: [{ path: "wiki/sources/source.md", operation: "update" }],
				};
			},
			handleResponse() {},
			rejectStream() {},
		},
	});

	const result = await ingest.handler({ sourcePath: "raw/sources/source.pdf" }, {});

	assert.equal(result.isError, undefined);
	assert.equal(bridgeCalls[0]?.toolName, "ingest_source");
	assert.deepEqual(bridgeCalls[0]?.args, { sourcePath: "raw/sources/source.pdf" });
	assert.deepEqual(changed, [{ path: "wiki/sources/source.md", operation: "update" }]);
	assert.deepEqual(sent.map((event) => event.type), [
		"agent_task_started",
		"agent_task_progress",
		"agent_task_done",
	]);
	assert.match(resultText(result), /"taskId": "ingest_source-/);
	assert.match(resultText(result), /wiki\/sources\/source.md/);
});

test("caption_source_images rejects when write tools are disabled", async () => {
	const caption = toolByName("caption_source_images", {
		streamId: "stream-1",
		enableWriteTools: false,
		appToolBridge: {
			async callTool() {
				throw new Error("should not call bridge");
			},
			handleResponse() {},
			rejectStream() {},
		},
	});

	const result = await caption.handler({ sourcePath: "raw/sources/source.pdf" }, {});

	assert.equal(result.isError, true);
	assert.match(resultText(result), /disabled/);
});

test("run_deep_research calls app bridge as write tool and returns app task id", async () => {
	const sent: Array<{ type: string; data: unknown }> = [];
	const bridgeCalls: Array<{ streamId: string; toolName: string; args: Record<string, unknown> }> = [];
	const runResearch = toolByName("run_deep_research", {
		streamId: "stream-1",
		enableWriteTools: true,
		emitAgentEvent: (type, data) => sent.push({ type, data }),
		appToolBridge: {
			async callTool(streamId, toolName, args) {
				bridgeCalls.push({ streamId, toolName, args });
				return {
					ok: true,
					result: { taskId: "research-42", status: "queued" },
				};
			},
			handleResponse() {},
			rejectStream() {},
		},
	});

	const result = await runResearch.handler(
		{ topic: "membrane bioreactor", sourceMode: "both" },
		{},
	);

	assert.equal(result.isError, undefined);
	assert.deepEqual(bridgeCalls, [
		{
			streamId: "stream-1",
			toolName: "run_deep_research",
			args: { topic: "membrane bioreactor", sourceMode: "both" },
		},
	]);
	assert.deepEqual(sent.map((event) => event.type), [
		"agent_task_started",
		"agent_task_progress",
		"agent_task_done",
	]);
	assert.match(resultText(result), /"taskId": "research-42"/);
});

test("collect_research_sources and get_agent_task_status are allowed without write tools", async () => {
	const bridgeCalls: string[] = [];
	const context = {
		streamId: "stream-1",
		enableWriteTools: false,
		appToolBridge: {
			async callTool(_streamId: string, toolName: string) {
				bridgeCalls.push(toolName);
				return { ok: true, result: { toolName } };
			},
			handleResponse() {},
			rejectStream() {},
		},
	};
	const collect = toolByName("collect_research_sources", context);
	const status = toolByName("get_agent_task_status", context);

	const collectResult = await collect.handler({ topic: "topic" }, {});
	const statusResult = await status.handler({ taskId: "research-1" }, {});

	assert.equal(collectResult.isError, undefined);
	assert.equal(statusResult.isError, undefined);
	assert.deepEqual(bridgeCalls, ["collect_research_sources", "get_agent_task_status"]);
});
