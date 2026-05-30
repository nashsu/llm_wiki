import { randomUUID } from "node:crypto";
import type {
	CanUseTool,
	PermissionDecisionClassification,
	PermissionResult,
	PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";
import { previewToolInput } from "./agent-policy.js";
import type { AgentMessage } from "./types.js";

type CanUseToolOptions = Parameters<CanUseTool>[2];

export interface AgentPermissionRequestPayload {
	requestId: string;
	toolName: string;
	inputPreview: Record<string, unknown>;
	suggestions?: PermissionUpdate[];
	blockedPath?: string;
	decisionReason?: string;
	title?: string;
	displayName?: string;
	description?: string;
	toolUseID: string;
	agentID?: string;
}

export type AgentPermissionDecision =
	| {
			behavior: "allow";
			updatedInput?: Record<string, unknown>;
			updatedPermissions?: PermissionUpdate[];
			decisionClassification?: PermissionDecisionClassification;
	  }
	| {
			behavior: "deny";
			message?: string;
			reason?: string;
			interrupt?: boolean;
			decisionClassification?: PermissionDecisionClassification;
	  };

export interface AgentPermissionResponseMessage {
	type: "permission_response";
	streamId: string;
	requestId: string;
	ok: boolean;
	decision?: AgentPermissionDecision;
	error?: string;
}

export interface PermissionBridge {
	requestPermission(
		streamId: string,
		toolName: string,
		input: Record<string, unknown>,
		options: CanUseToolOptions,
	): Promise<PermissionResult>;
	handleResponse(response: AgentPermissionResponseMessage): void;
	rejectStream(streamId: string, reason: string): void;
}

interface PendingPermission {
	streamId: string;
	toolUseID: string;
	resolve: (value: PermissionResult) => void;
	reject: (err: Error) => void;
	timer: NodeJS.Timeout;
}

function toPermissionResult(
	decision: AgentPermissionDecision,
	toolUseID: string,
): PermissionResult {
	if (decision.behavior === "allow") {
		return {
			behavior: "allow",
			updatedInput: decision.updatedInput,
			updatedPermissions: decision.updatedPermissions,
			toolUseID,
			decisionClassification: decision.decisionClassification,
		};
	}
	return {
		behavior: "deny",
		message: decision.message ?? decision.reason ?? "Permission denied",
		interrupt: decision.interrupt,
		toolUseID,
		decisionClassification: decision.decisionClassification,
	};
}

export function createPermissionBridge(args: {
	send: (msg: AgentMessage) => void;
	timeoutMs?: number;
}): PermissionBridge {
	const pending = new Map<string, PendingPermission>();
	const timeoutMs = args.timeoutMs ?? 120_000;

	return {
		requestPermission(streamId, toolName, input, options) {
			const requestId = randomUUID();
			return new Promise<PermissionResult>((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(requestId);
					resolve({
						behavior: "deny",
						message: `Permission request timed out: ${toolName}`,
						toolUseID: options.toolUseID,
					});
				}, timeoutMs);
				pending.set(requestId, {
					streamId,
					toolUseID: options.toolUseID,
					resolve,
					reject,
					timer,
				});
				args.send({
					streamId,
					type: "agent_permission_request",
					data: {
						requestId,
						toolName,
						inputPreview: previewToolInput(input),
						suggestions: options.suggestions,
						blockedPath: options.blockedPath,
						decisionReason: options.decisionReason,
						title: options.title,
						displayName: options.displayName,
						description: options.description,
						toolUseID: options.toolUseID,
						agentID: options.agentID,
					},
				});
			});
		},

		handleResponse(response) {
			const call = pending.get(response.requestId);
			if (!call) return;
			pending.delete(response.requestId);
			clearTimeout(call.timer);
			if (!response.ok) {
				call.reject(new Error(response.error || "Permission request failed"));
				return;
			}
			if (!response.decision) {
				call.reject(new Error("Permission response missing decision"));
				return;
			}
			call.resolve(toPermissionResult(response.decision, call.toolUseID));
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
