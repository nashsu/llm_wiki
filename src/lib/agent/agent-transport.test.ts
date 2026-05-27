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
		reset: () => {
			for (const event of Object.keys(listeners)) {
				delete listeners[event];
			}
		},
	};
});

vi.mock("@tauri-apps/api/core", () => ({
	invoke: tauriMocks.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: tauriMocks.listen,
}));

import { streamAgent } from "./agent-transport";

beforeEach(() => {
	vi.clearAllMocks();
	tauriMocks.reset();
	tauriMocks.invoke.mockResolvedValue(undefined);
});

describe("streamAgent", () => {
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

		tauriMocks.emit(
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
});
