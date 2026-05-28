import { randomUUID } from "node:crypto";
import type { AgentMessage } from "./types.js";

export interface AppToolRequestPayload {
	requestId: string;
	toolName: string;
	args: Record<string, unknown>;
}

export interface AppToolResponseMessage {
	type: "app_tool_response";
	streamId: string;
	requestId: string;
	ok: boolean;
	data?: unknown;
	error?: string;
}

export interface AppToolBridge {
	callTool(
		streamId: string,
		toolName: string,
		args: Record<string, unknown>,
	): Promise<unknown>;
	handleResponse(response: AppToolResponseMessage): void;
	rejectStream(streamId: string, reason: string): void;
}

interface PendingCall {
	streamId: string;
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
	timer: NodeJS.Timeout;
}

export function createAppToolBridge(args: {
	send: (msg: AgentMessage) => void;
	timeoutMs?: number;
}): AppToolBridge {
	const pending = new Map<string, PendingCall>();
	const timeoutMs = args.timeoutMs ?? 120_000;

	return {
		callTool(streamId, toolName, toolArgs) {
			const requestId = randomUUID();
			return new Promise<unknown>((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(requestId);
					reject(new Error(`App tool timed out: ${toolName}`));
				}, timeoutMs);
				pending.set(requestId, {
					streamId,
					resolve,
					reject,
					timer,
				});
				args.send({
					streamId,
					type: "app_tool_request",
					data: {
						requestId,
						toolName,
						args: toolArgs,
					},
				});
			});
		},

		handleResponse(response) {
			const call = pending.get(response.requestId);
			if (!call) return;
			pending.delete(response.requestId);
			clearTimeout(call.timer);
			if (response.ok) {
				call.resolve(response.data);
			} else {
				call.reject(new Error(response.error || "App tool failed"));
			}
		},

		rejectStream(streamId, reason) {
			for (const [requestId, call] of pending) {
				if (call.streamId !== streamId) continue;
				pending.delete(requestId);
				clearTimeout(call.timer);
				call.reject(new Error(reason));
			}
		},
	};
}
