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
	AgentActionRequiredPayload,
	AgentDonePayload,
	AgentSummaryPayload,
	AgentTransportOptions,
	AgentToolEventPayload,
	AgentWikiChangedPayload,
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
	permissionPolicy?: "default" | "restricted" | "bypass";
	projectId?: string;
	projectPath?: string;
	apiServerBaseUrl?: string;
	apiToken?: string;
	enableWikiTools?: boolean;
	enableWriteTools?: boolean;
	maxWriteBytes?: number;
	maxFilesChanged?: number;
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
		console.log(
			"[agent-transport] step 1: setting up listeners, streamId=",
			streamId,
		);

		unlistenData = await listen<string>(`agent:${streamId}`, (event) => {
			try {
				const raw = event.payload;
				console.log("[agent-transport] raw:", raw?.slice(0, 500));

				const wrapper = JSON.parse(raw) as {
					streamId: string;
					type: string;
					data: unknown;
				};

				const msg = wrapper.data;
				if (!msg) {
					console.log(
						"[agent-transport] null data, wrapper.type:",
						wrapper.type,
					);
					return;
				}

				if (wrapper.type === "wiki_changed") {
					callbacks.onWikiChanged?.(msg as unknown as AgentWikiChangedPayload);
					return;
				}

				if (wrapper.type === "tool_event") {
					callbacks.onToolEvent?.(msg as AgentToolEventPayload);
					return;
				}

				if (wrapper.type === "agent_summary") {
					callbacks.onAgentSummary?.(msg as AgentSummaryPayload);
					return;
				}

				if (wrapper.type === "agent_action_required") {
					callbacks.onActionRequired?.(msg as AgentActionRequiredPayload);
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
					(msg as SDKMessage).type,
					"keys:",
					Object.keys(msg as Record<string, unknown>).join(","),
				);
				callbacks.onMessage(msg as SDKMessage);

				if ((msg as SDKMessage).type === "assistant") {
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

				if ((msg as SDKMessage).type === "result") {
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

		console.log("[agent-transport] step 2: listeners ready, building payload");
		const payload: InvokePayload = {
			streamId,
			prompt,
			...options,
		};
		console.log(
			"[agent-transport] step 3: invoking agent_spawn, payload keys:",
			Object.keys(payload).join(","),
		);
		try {
			await invoke("agent_spawn", { args: payload });
			console.log("[agent-transport] step 4: invoke returned successfully");
		} catch (invokeErr) {
			console.error("[agent-transport] invoke FAILED:", invokeErr);
			throw invokeErr;
		}
	} catch (err) {
		console.error(
			"[agent-transport] OUTER CATCH — error type:",
			typeof err,
			"value:",
			err,
		);
		finishWith(() => {
			let message: string;
			if (err instanceof Error) {
				message = `[outer-catch] ${err.constructor.name}: ${err.message}`;
			} else if (err === null) {
				message = "[outer-catch] null error thrown";
			} else if (err === undefined) {
				message = "[outer-catch] undefined error thrown";
			} else {
				message = `[outer-catch] ${typeof err}: ${String(err)}`;
			}
			callbacks.onError(new Error(message));
		});
	} finally {
		signal?.removeEventListener("abort", abortListener);
	}
}
