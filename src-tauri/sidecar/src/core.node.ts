import assert from "node:assert/strict";
import test from "node:test";
import { createRequestHandler, omitNullish, type QueryFn } from "./core.js";
import type { AgentMessage, AgentRequest } from "./types.js";

const baseRequest: AgentRequest = {
	type: "query",
	streamId: "stream-1",
	prompt: "hello",
	options: {
		systemPrompt: "system",
		cwd: undefined,
		model: "claude-sonnet-4-20250514",
		maxTurns: undefined,
		maxBudgetUsd: undefined,
		apiKey: "test-key",
		baseUrl: "http://localhost:4000",
		persistSession: false,
	},
};

test("omitNullish removes null and undefined but keeps falsey values", () => {
	assert.deepEqual(
		omitNullish({
			empty: "",
			falseValue: false,
			nullValue: null,
			undefinedValue: undefined,
			zero: 0,
		}),
		{
			empty: "",
			falseValue: false,
			zero: 0,
		},
	);
});

test("query request strips nullish SDK options and emits message then done", async () => {
	const sent: AgentMessage[] = [];
	let capturedInput: Parameters<QueryFn>[0] | undefined;
	const queryFn: QueryFn = async function* (input) {
		capturedInput = input;
		yield { type: "assistant", message: { content: [] } };
	};

	const handleRequest = createRequestHandler({
		queryFn,
		send: (msg) => sent.push(msg),
		error: () => {},
		env: {},
	});

	await handleRequest({
		...baseRequest,
		options: {
			...baseRequest.options,
			cwd: null as unknown as string,
			maxBudgetUsd: null as unknown as number,
		},
	});

	assert.equal(capturedInput?.prompt, "hello");
	assert.equal(capturedInput?.options?.cwd, undefined);
	assert.equal(capturedInput?.options?.maxBudgetUsd, undefined);
	assert.equal(capturedInput?.options?.maxTurns, 10);
	assert.equal(capturedInput?.options?.tools, undefined);
	assert.deepEqual(capturedInput?.options?.allowedTools, []);
	assert.equal(capturedInput?.options?.permissionMode, "default");
	assert.equal(
		"allowDangerouslySkipPermissions" in (capturedInput?.options ?? {}),
		false,
	);
	assert.deepEqual(sent.map((msg) => msg.type), ["message", "done"]);
});

test("query request forwards session options to the SDK", async () => {
	let capturedInput: Parameters<QueryFn>[0] | undefined;
	const queryFn: QueryFn = async function* (input) {
		capturedInput = input;
	};

	const handleRequest = createRequestHandler({
		queryFn,
		send: () => {},
		error: () => {},
		env: {},
	});

	await handleRequest({
		...baseRequest,
		options: {
			...baseRequest.options,
			sessionId: "11111111-1111-4111-8111-111111111111",
			resume: "22222222-2222-4222-8222-222222222222",
			continue: true,
			forkSession: true,
			resumeSessionAt: "msg-1",
			persistSession: true,
			title: "Wiki Agent",
		},
	});

	assert.equal(
		capturedInput?.options?.sessionId,
		"11111111-1111-4111-8111-111111111111",
	);
	assert.equal(
		capturedInput?.options?.resume,
		"22222222-2222-4222-8222-222222222222",
	);
	assert.equal(capturedInput?.options?.continue, true);
	assert.equal(capturedInput?.options?.forkSession, true);
	assert.equal(capturedInput?.options?.resumeSessionAt, "msg-1");
	assert.equal(capturedInput?.options?.persistSession, true);
	assert.equal(capturedInput?.options?.title, "Wiki Agent");
});

test("canUseTool pre-approves allowed Wiki tools and denies disabled Wiki writes", async () => {
	let capturedInput: Parameters<QueryFn>[0] | undefined;
	let bridgeCalls = 0;
	const queryFn: QueryFn = async function* (input) {
		capturedInput = input;
	};

	const handleRequest = createRequestHandler({
		queryFn,
		send: () => {},
		error: () => {},
		env: {},
		permissionBridge: {
			requestPermission: async () => {
				bridgeCalls += 1;
				throw new Error("bridge should not be called for Wiki tools");
			},
			handleResponse: () => {},
			rejectStream: () => {},
		},
	});

	await handleRequest({
		...baseRequest,
		options: {
			...baseRequest.options,
			projectPath: "/tmp/wiki",
			enableWikiTools: true,
			enableWriteTools: false,
		},
	});

	const canUseTool = capturedInput?.options?.canUseTool;
	assert.ok(canUseTool);
	const signal = new AbortController().signal;
	assert.deepEqual(
		await canUseTool(
			"mcp__llm_wiki__read_page",
			{ path: "wiki/index.md" },
			{ signal, toolUseID: "tool-1" },
		),
		{
			behavior: "allow",
			toolUseID: "tool-1",
		},
	);
	assert.deepEqual(
		await canUseTool(
			"mcp__llm_wiki__update_page",
			{ path: "wiki/index.md" },
			{ signal, toolUseID: "tool-2" },
		),
		{
			behavior: "deny",
			message: "Wiki write tools are disabled",
			toolUseID: "tool-2",
		},
	);
	assert.equal(bridgeCalls, 0);
});

test("canUseTool asks permission bridge for non-Wiki tools", async () => {
	let capturedInput: Parameters<QueryFn>[0] | undefined;
	const bridgeCalls: Array<{
		streamId: string;
		toolName: string;
		input: Record<string, unknown>;
		toolUseID: string;
	}> = [];
	const queryFn: QueryFn = async function* (input) {
		capturedInput = input;
	};

	const handleRequest = createRequestHandler({
		queryFn,
		send: () => {},
		error: () => {},
		env: {},
		permissionBridge: {
			requestPermission: async (streamId, toolName, input, options) => {
				bridgeCalls.push({
					streamId,
					toolName,
					input,
					toolUseID: options.toolUseID,
				});
				return {
					behavior: "allow",
					toolUseID: options.toolUseID,
				};
			},
			handleResponse: () => {},
			rejectStream: () => {},
		},
	});

	await handleRequest(baseRequest);

	const canUseTool = capturedInput?.options?.canUseTool;
	assert.ok(canUseTool);
	assert.deepEqual(
		await canUseTool(
			"Bash",
			{ command: "pwd" },
			{ signal: new AbortController().signal, toolUseID: "tool-3" },
		),
		{
			behavior: "allow",
			toolUseID: "tool-3",
		},
	);
	assert.deepEqual(bridgeCalls, [
		{
			streamId: "stream-1",
			toolName: "Bash",
			input: { command: "pwd" },
			toolUseID: "tool-3",
		},
	]);
});

test("query request enables LLM Wiki MCP tools when project context is present", async () => {
	let capturedInput: Parameters<QueryFn>[0] | undefined;
	const queryFn: QueryFn = async function* (input) {
		capturedInput = input;
	};

	const handleRequest = createRequestHandler({
		queryFn,
		send: () => {},
		error: () => {},
		env: {},
	});

	await handleRequest({
		...baseRequest,
		options: {
			...baseRequest.options,
			projectPath: "/tmp/wiki",
			apiServerBaseUrl: "http://127.0.0.1:19828",
			enableWikiTools: true,
			enableWriteTools: true,
		},
	});

	assert.equal(capturedInput?.options?.tools, undefined);
	assert.equal(capturedInput?.options?.permissionMode, "default");
	assert.deepEqual(capturedInput?.options?.allowedTools, [
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
		"mcp__llm_wiki__update_page",
		"mcp__llm_wiki__create_entity",
		"mcp__llm_wiki__create_concept",
		"mcp__llm_wiki__save_query_page",
		"mcp__llm_wiki__run_deep_research",
		"mcp__llm_wiki__ingest_source",
		"mcp__llm_wiki__caption_source_images",
		"mcp__llm_wiki__fix_lint_result",
		"mcp__llm_wiki__enrich_wikilinks",
		"mcp__llm_wiki__sweep_reviews",
	]);
	assert.ok(capturedInput?.options?.mcpServers);
	assert.ok(capturedInput?.options?.hooks);
});

test("query request can restrict tools to pre-approved Wiki MCP tools", async () => {
	let capturedInput: Parameters<QueryFn>[0] | undefined;
	const queryFn: QueryFn = async function* (input) {
		capturedInput = input;
	};

	const handleRequest = createRequestHandler({
		queryFn,
		send: () => {},
		error: () => {},
		env: {},
	});

	await handleRequest({
		...baseRequest,
		options: {
			...baseRequest.options,
			projectPath: "/tmp/wiki",
			enableWikiTools: true,
			enableWriteTools: false,
			permissionPolicy: "restricted",
		},
	});

	assert.deepEqual(capturedInput?.options?.tools, []);
	assert.equal(capturedInput?.options?.permissionMode, "dontAsk");
	assert.deepEqual(capturedInput?.options?.allowedTools, [
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
	]);
});

test("query request can explicitly bypass SDK permissions", async () => {
	let capturedInput: Parameters<QueryFn>[0] | undefined;
	const queryFn: QueryFn = async function* (input) {
		capturedInput = input;
	};

	const handleRequest = createRequestHandler({
		queryFn,
		send: () => {},
		error: () => {},
		env: {},
	});

	await handleRequest({
		...baseRequest,
		options: {
			...baseRequest.options,
			permissionPolicy: "bypass",
		},
	});

	assert.equal(capturedInput?.options?.tools, undefined);
	assert.equal(capturedInput?.options?.permissionMode, "bypassPermissions");
	assert.equal(capturedInput?.options?.allowDangerouslySkipPermissions, true);
});

test("kill request aborts active query and removes it from tracking", async () => {
	const activeQueries = new Map<string, AbortController>();
	let capturedSignal: AbortSignal | undefined;
	let releaseQuery: (() => void) | undefined;
	let rejectedStream: string | undefined;
	const queryFn: QueryFn = async function* (input) {
		capturedSignal = input.options?.abortController?.signal;
		await new Promise<void>((resolve) => {
			releaseQuery = resolve;
		});
	};

	const handleRequest = createRequestHandler({
		queryFn,
		send: () => {},
		error: () => {},
		activeQueries,
		env: {},
		permissionBridge: {
			requestPermission: async () => ({ behavior: "deny", message: "no" }),
			handleResponse: () => {},
			rejectStream: (streamId) => {
				rejectedStream = streamId;
			},
		},
	});

	const running = handleRequest(baseRequest);
	await Promise.resolve();

	assert.equal(activeQueries.has("stream-1"), true);
	await handleRequest({ type: "kill", streamId: "stream-1" });
	assert.equal(capturedSignal?.aborted, true);
	assert.equal(activeQueries.has("stream-1"), false);
	assert.equal(rejectedStream, "stream-1");

	releaseQuery?.();
	await running;
});

test("query errors emit error message and cleanup active query", async () => {
	const sent: AgentMessage[] = [];
	const activeQueries = new Map<string, AbortController>();
	const queryFn: QueryFn = async function* () {
		throw new Error("boom");
	};

	const handleRequest = createRequestHandler({
		queryFn,
		send: (msg) => sent.push(msg),
		error: () => {},
		activeQueries,
		env: {},
	});

	await handleRequest(baseRequest);

	assert.equal(activeQueries.size, 0);
	assert.equal(sent.length, 1);
	assert.equal(sent[0]?.type, "error");
	assert.match(String((sent[0]?.data as { error?: string }).error), /boom/);
});
