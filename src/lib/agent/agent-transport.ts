/**
 * Agent sidecar transport.
 *
 * Spawns a Node.js sidecar via Rust that uses the Claude Agent SDK.
 * Communication follows the same emit/listen + streamId pattern as
 * claude-cli-transport.ts. The sidecar outputs JSON-lines with
 * { streamId, type, data } where data is an SDKMessage object.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
	AgentCallbacks,
	AgentDonePayload,
	AgentTransportOptions,
	SDKAssistantMessage,
	SDKContentBlock,
	SDKMessage,
	SDKResultMessage,
} from "./agent-types";

type InvokePayload = Record<string, unknown> & {
	streamId: string;
	prompt: string;
	systemPrompt?: string;
	cwd?: string;
	model?: string;
	maxTurns?: number;
	maxBudgetUsd?: number;
	apiKey?: string;
	baseUrl?: string;
};

function extractText(content: SDKContentBlock[]): string {
	return content
		.filter(
			(b): b is { type: "text"; text: string } =>
				b.type === "text" && typeof b.text === "string",
		)
		.map((b) => b.text)
		.join("");
}

export async function streamAgent(
	prompt: string,
	options: AgentTransportOptions,
	callbacks: AgentCallbacks,
	signal?: AbortSignal,
): Promise<void> {
	const streamId = crypto.randomUUID();
	let unlistenData: UnlistenFn | undefined;
	let unlistenDone: UnlistenFn | undefined;
	let finished = false;

	const cleanup = () => {
		unlistenData?.();
		unlistenDone?.();
	};

	const finishWith = (cb: () => void) => {
		if (finished) return;
		finished = true;
		cleanup();
		cb();
	};

	const abortListener = () => {
		void invoke("agent_kill", { streamId }).catch(() => {});
		finishWith(() => callbacks.onDone(null));
	};
	signal?.addEventListener("abort", abortListener);

	try {
		// Track text already emitted to avoid double-counting. The SDK can
		// emit multiple assistant messages for the same turn as the content
		// grows (partial messages). We diff against what we've already sent.
		let emittedText = "";

		unlistenData = await listen<string>(`agent:${streamId}`, (event) => {
			try {
				const wrapper = JSON.parse(event.payload) as {
					streamId: string;
					type: string;
					data: SDKMessage;
				};

				const msg = wrapper.data;
				callbacks.onMessage(msg);

				if (msg.type === "assistant") {
					const assistant = msg as SDKAssistantMessage;
					const content = assistant.message?.content;
					if (!Array.isArray(content)) return;
					const fullText = extractText(content);
					if (fullText.startsWith(emittedText)) {
						const novel = fullText.slice(emittedText.length);
						emittedText = fullText;
						if (novel) callbacks.onToken(novel);
					} else {
						emittedText = fullText;
						callbacks.onToken(fullText);
					}
				}

				if (msg.type === "result") {
					const result = msg as SDKResultMessage;
					// Reset for next turn
					emittedText = "";
					callbacks.onToken("\n");
				}
			} catch {
				// ignore parse errors
			}
		});

		unlistenDone = await listen<AgentDonePayload>(
			`agent:${streamId}:done`,
			(event) => {
				const { code, stderr } = event.payload ?? {};
				if (code !== undefined && code !== 0) {
					const detail = stderr?.trim() ? `: ${stderr.trim()}` : "";
					finishWith(() =>
						callbacks.onError(
							new Error(`Agent exited with code ${code}${detail}`),
						),
					);
				} else {
					finishWith(() => callbacks.onDone(null));
				}
			},
		);

		const payload: InvokePayload = {
			streamId,
			prompt,
			...options,
		};
		await invoke("agent_spawn", payload);
	} catch (err) {
		finishWith(() => {
			const message = err instanceof Error ? err.message : String(err);
			callbacks.onError(err instanceof Error ? err : new Error(message));
		});
	} finally {
		signal?.removeEventListener("abort", abortListener);
	}
}
