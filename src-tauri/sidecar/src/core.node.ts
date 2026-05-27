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
	assert.deepEqual(sent.map((msg) => msg.type), ["message", "done"]);
});

test("kill request aborts active query and removes it from tracking", async () => {
	const activeQueries = new Map<string, AbortController>();
	let capturedSignal: AbortSignal | undefined;
	let releaseQuery: (() => void) | undefined;
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
	});

	const running = handleRequest(baseRequest);
	await Promise.resolve();

	assert.equal(activeQueries.has("stream-1"), true);
	await handleRequest({ type: "kill", streamId: "stream-1" });
	assert.equal(capturedSignal?.aborted, true);
	assert.equal(activeQueries.has("stream-1"), false);

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
