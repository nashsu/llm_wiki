import { beforeEach, describe, expect, it, vi } from "vitest";

const tauriMocks = vi.hoisted(() => {
	const listeners: Record<string, (event: { payload: unknown }) => void> = {};
	return {
		invoke: vi.fn(async (_command: string, _payload?: unknown): Promise<unknown> => undefined),
		listen: vi.fn(async (event: string, cb: (event: { payload: unknown }) => void) => {
			listeners[event] = cb;
			return vi.fn(() => {
				delete listeners[event];
			});
		}),
		emit: (event: string, payload: unknown) => listeners[event]?.({ payload }),
		emitString: (event: string, payload: string) => listeners[event]?.({ payload }),
		reset: () => {
			for (const event of Object.keys(listeners)) {
				delete listeners[event];
			}
		},
	};
});

const appToolMocks = vi.hoisted(() => ({
	runAgentAppTool: vi.fn(async () => ({ ok: true, result: { value: "ok" } })),
}));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: tauriMocks.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: tauriMocks.listen,
}));

vi.mock("./agent-app-tools", () => ({
	runAgentAppTool: appToolMocks.runAgentAppTool,
}));

import { streamAgent } from "./agent-transport";

beforeEach(() => {
	vi.clearAllMocks();
	tauriMocks.reset();
	tauriMocks.invoke.mockResolvedValue(undefined);
	appToolMocks.runAgentAppTool.mockResolvedValue({ ok: true, result: { value: "ok" } });
});

describe("streamAgent", () => {
	it("passes session options to agent_spawn", async () => {
		const callbacks = {
			onMessage: vi.fn(),
			onToken: vi.fn(),
			onDone: vi.fn(),
			onError: vi.fn(),
		};

		const stream = streamAgent(
			"resume agent",
			{
				apiKey: "test-key",
				sessionId: "11111111-1111-4111-8111-111111111111",
				resume: "22222222-2222-4222-8222-222222222222",
				continueSession: true,
				forkSession: true,
				resumeSessionAt: "msg-1",
				persistSession: true,
				title: "Wiki Agent",
			},
			callbacks,
		);

		await vi.waitFor(() => {
			expect(tauriMocks.invoke).toHaveBeenCalledTimes(1);
		});

		const payload = tauriMocks.invoke.mock.calls[0]?.[1] as {
			args: Record<string, unknown> & { streamId: string };
		};
		expect(payload.args).toMatchObject({
			prompt: "resume agent",
			sessionId: "11111111-1111-4111-8111-111111111111",
			resume: "22222222-2222-4222-8222-222222222222",
			continueSession: true,
			forkSession: true,
			resumeSessionAt: "msg-1",
			persistSession: true,
			title: "Wiki Agent",
		});

		tauriMocks.emit(`agent:${payload.args.streamId}:done`, {
			code: 0,
			stderr: "",
		});

		await stream;

		expect(callbacks.onDone).toHaveBeenCalledWith(null);
		expect(callbacks.onError).not.toHaveBeenCalled();
	});

	it("returns SDK result metadata through onDone", async () => {
		const callbacks = {
			onMessage: vi.fn(),
			onToken: vi.fn(),
			onDone: vi.fn(),
			onError: vi.fn(),
		};

		const stream = streamAgent("run agent", { apiKey: "test-key" }, callbacks);

		await vi.waitFor(() => {
			expect(tauriMocks.invoke).toHaveBeenCalledTimes(1);
		});

		const payload = tauriMocks.invoke.mock.calls[0]?.[1] as {
			args: { streamId: string };
		};
		const result = {
			type: "result",
			result: "ok",
			session_id: "11111111-1111-4111-8111-111111111111",
			total_cost_usd: 0.01,
			duration_ms: 1234,
			usage: {
				input_tokens: 10,
				output_tokens: 5,
			},
		};

		tauriMocks.emitString(
			`agent:${payload.args.streamId}`,
			JSON.stringify({
				streamId: payload.args.streamId,
				type: "message",
				data: result,
			}),
		);
		tauriMocks.emit(`agent:${payload.args.streamId}:done`, {
			code: 0,
			stderr: "",
		});

		await stream;

		expect(callbacks.onMessage).toHaveBeenCalledWith(result);
		expect(callbacks.onToken).toHaveBeenCalledWith("\n");
		expect(callbacks.onDone).toHaveBeenCalledWith(result);
		expect(callbacks.onError).not.toHaveBeenCalled();
	});

	it("forwards wiki_changed events to the wiki change callback", async () => {
		const callbacks = {
			onMessage: vi.fn(),
			onToken: vi.fn(),
			onDone: vi.fn(),
			onError: vi.fn(),
			onWikiChanged: vi.fn(),
		};

		const stream = streamAgent(
			"update wiki",
			{
				apiKey: "test-key",
				projectPath: "/tmp/wiki",
				enableWikiTools: true,
			},
			callbacks,
		);

		await vi.waitFor(() => {
			expect(tauriMocks.invoke).toHaveBeenCalledTimes(1);
		});

		const payload = tauriMocks.invoke.mock.calls[0]?.[1] as {
			args: { streamId: string };
		};
		const changed = {
			path: "wiki/entities/example.md",
			operation: "update",
			oldSha256: "old",
			newSha256: "new",
		};

		tauriMocks.emitString(
			`agent:${payload.args.streamId}`,
			JSON.stringify({
				streamId: payload.args.streamId,
				type: "wiki_changed",
				data: changed,
			}),
		);
		tauriMocks.emit(`agent:${payload.args.streamId}:done`, {
			code: 0,
			stderr: "",
		});

		await stream;

		expect(callbacks.onWikiChanged).toHaveBeenCalledWith(changed);
		expect(callbacks.onMessage).not.toHaveBeenCalled();
		expect(callbacks.onToken).not.toHaveBeenCalled();
		expect(callbacks.onDone).toHaveBeenCalledWith(null);
		expect(callbacks.onError).not.toHaveBeenCalled();
	});

	it("forwards sidecar control events to optional callbacks", async () => {
		const callbacks = {
			onMessage: vi.fn(),
			onToken: vi.fn(),
			onDone: vi.fn(),
			onError: vi.fn(),
			onWikiChanged: vi.fn(),
			onToolEvent: vi.fn(),
			onAgentSummary: vi.fn(),
			onActionRequired: vi.fn(),
		};

		const stream = streamAgent("run agent", { apiKey: "test-key" }, callbacks);

		await vi.waitFor(() => {
			expect(tauriMocks.invoke).toHaveBeenCalledTimes(1);
		});

		const payload = tauriMocks.invoke.mock.calls[0]?.[1] as {
			args: { streamId: string };
		};
		const streamEvent = `agent:${payload.args.streamId}`;
		const toolEvent = {
			phase: "pre",
			toolName: "mcp__llm_wiki__read_page",
			toolUseId: "tool-1",
		};
		const summary = {
			changedPaths: ["wiki/entities/example.md"],
			toolCalls: 1,
			failedToolCalls: 0,
		};
		const action = {
			kind: "lint_recommended",
			paths: ["wiki/entities/example.md"],
			reason: "agent_write",
		};

		tauriMocks.emitString(
			streamEvent,
			JSON.stringify({
				streamId: payload.args.streamId,
				type: "tool_event",
				data: toolEvent,
			}),
		);
		tauriMocks.emitString(
			streamEvent,
			JSON.stringify({
				streamId: payload.args.streamId,
				type: "agent_summary",
				data: summary,
			}),
		);
		tauriMocks.emitString(
			streamEvent,
			JSON.stringify({
				streamId: payload.args.streamId,
				type: "agent_action_required",
				data: action,
			}),
		);
		tauriMocks.emit(`agent:${payload.args.streamId}:done`, {
			code: 0,
			stderr: "",
		});

		await stream;

		expect(callbacks.onToolEvent).toHaveBeenCalledWith(toolEvent);
		expect(callbacks.onAgentSummary).toHaveBeenCalledWith(summary);
		expect(callbacks.onActionRequired).toHaveBeenCalledWith(action);
		expect(callbacks.onMessage).not.toHaveBeenCalled();
		expect(callbacks.onDone).toHaveBeenCalledWith(null);
		expect(callbacks.onError).not.toHaveBeenCalled();
	});

	it("handles app tool requests and sends responses back to the sidecar", async () => {
		const callbacks = {
			onMessage: vi.fn(),
			onToken: vi.fn(),
			onDone: vi.fn(),
			onError: vi.fn(),
		};

		const stream = streamAgent("run app tool", { apiKey: "test-key" }, callbacks);

		await vi.waitFor(() => {
			expect(tauriMocks.invoke).toHaveBeenCalledTimes(1);
		});

		const payload = tauriMocks.invoke.mock.calls[0]?.[1] as {
			args: { streamId: string };
		};
		const streamEvent = `agent:${payload.args.streamId}`;

		tauriMocks.emitString(
			streamEvent,
			JSON.stringify({
				streamId: payload.args.streamId,
				type: "app_tool_request",
				data: {
					requestId: "request-1",
					toolName: "run_lint",
					args: { includeSemantic: false },
				},
			}),
		);

		await vi.waitFor(() => {
			expect(appToolMocks.runAgentAppTool).toHaveBeenCalledWith("run_lint", {
				includeSemantic: false,
			});
			expect(tauriMocks.invoke).toHaveBeenCalledWith("agent_tool_response", {
				streamId: payload.args.streamId,
				requestId: "request-1",
				ok: true,
				data: { ok: true, result: { value: "ok" } },
			});
		});

		tauriMocks.emit(`agent:${payload.args.streamId}:done`, {
			code: 0,
			stderr: "",
		});

		await stream;

		expect(callbacks.onMessage).not.toHaveBeenCalled();
		expect(callbacks.onDone).toHaveBeenCalledWith(null);
		expect(callbacks.onError).not.toHaveBeenCalled();
	});
});
