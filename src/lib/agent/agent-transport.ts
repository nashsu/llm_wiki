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
		let emittedText = "";

		unlistenData = await listen<string>(`agent:${streamId}`, (event) => {
			try {
				const raw = event.payload;
				console.log("[agent-transport] raw:", raw?.slice(0, 500));

				const wrapper = JSON.parse(raw) as {
					streamId: string;
					type: string;
					data: SDKMessage;
				};

				const msg = wrapper.data;
				if (!msg) {
					console.log(
						"[agent-transport] null data, wrapper.type:",
						wrapper.type,
					);
					return;
				}

				// Handle sidecar-level errors (wrapper.type === "error")
				if (wrapper.type === "error") {
					const errMsg =
						(msg as Record<string, unknown>).error ??
						(msg as Record<string, unknown>).stack ??
						"Unknown sidecar error";
					console.error("[agent-transport] sidecar error:", errMsg);
					finishWith(() => callbacks.onError(new Error(String(errMsg))));
					return;
				}

				console.log(
					"[agent-transport] msg.type:",
					msg.type,
					"keys:",
					Object.keys(msg).join(","),
				);
				callbacks.onMessage(msg);

				if (msg.type === "assistant") {
					const assistant = msg as SDKAssistantMessage;
					console.log(
						"[agent-transport] assistant message keys:",
						Object.keys(assistant).join(","),
						"has message?",
						"message" in assistant,
					);
					const content = assistant.message?.content;
					if (!Array.isArray(content)) {
						console.log(
							"[agent-transport] no array content, assistant:",
							JSON.stringify(assistant).slice(0, 300),
						);
						return;
					}
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
					console.log(
						"[agent-transport] result:",
						JSON.stringify(result).slice(0, 200),
					);
					emittedText = "";
					callbacks.onToken("\n");
				}
			} catch (err) {
				console.error("[agent-transport] parse error:", err);
			}
		});

		unlistenDone = await listen<AgentDonePayload>(
			`agent:${streamId}:done`,
			(event) => {
				console.log(
					"[agent-transport] done event:",
					JSON.stringify(event.payload),
				);
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
