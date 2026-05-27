import type {
	HookCallbackMatcher,
	HookEvent,
	PostToolBatchHookInput,
	PostToolUseFailureHookInput,
	PostToolUseHookInput,
	PreToolUseHookInput,
	StopHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentMessage } from "./types.js";
import {
	isWikiToolName,
	previewToolInput,
	shouldAllowWikiTool,
	type AgentPermissionPolicy,
} from "./agent-policy.js";

interface LlmWikiHookContext {
	streamId: string;
	enableWriteTools: boolean;
	permissionPolicy: AgentPermissionPolicy;
	changedPaths: Set<string>;
	send: (msg: AgentMessage) => void;
}

export function createLlmWikiHooks(
	context: LlmWikiHookContext,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
	let toolCalls = 0;
	let failedToolCalls = 0;

	const send = (type: AgentMessage["type"], data: unknown) => {
		context.send({ streamId: context.streamId, type, data });
	};

	return {
		PreToolUse: [
			{
				hooks: [
					async (input) => {
						const event = input as PreToolUseHookInput;
						if (!isWikiToolName(event.tool_name)) return {};
						toolCalls += 1;
						const decision = shouldAllowWikiTool({
							toolName: event.tool_name,
							enableWriteTools: context.enableWriteTools,
						});
						send("tool_event", {
							phase: "pre",
							toolName: event.tool_name,
							toolUseId: event.tool_use_id,
							inputPreview: previewToolInput(event.tool_input),
							permissionPolicy: context.permissionPolicy,
						});
						if (!decision.allowed) {
							failedToolCalls += 1;
							return {
								hookSpecificOutput: {
									hookEventName: "PreToolUse" as const,
									permissionDecision: "deny" as const,
									permissionDecisionReason: decision.reason,
								},
							};
						}
						return {
							hookSpecificOutput: {
								hookEventName: "PreToolUse" as const,
								permissionDecision: "allow" as const,
							},
						};
					},
				],
			},
		],
		PostToolUse: [
			{
				hooks: [
					async (input) => {
						const event = input as PostToolUseHookInput;
						if (!isWikiToolName(event.tool_name)) return {};
						send("tool_event", {
							phase: "post",
							toolName: event.tool_name,
							toolUseId: event.tool_use_id,
							ok: true,
							durationMs: event.duration_ms,
							inputPreview: previewToolInput(event.tool_input),
						});
						return {};
					},
				],
			},
		],
		PostToolUseFailure: [
			{
				hooks: [
					async (input) => {
						const event = input as PostToolUseFailureHookInput;
						if (!isWikiToolName(event.tool_name)) return {};
						failedToolCalls += 1;
						send("tool_event", {
							phase: "failure",
							toolName: event.tool_name,
							toolUseId: event.tool_use_id,
							ok: false,
							durationMs: event.duration_ms,
							inputPreview: previewToolInput(event.tool_input),
							error: event.error,
						});
						return {};
					},
				],
			},
		],
		PostToolBatch: [
			{
				hooks: [
					async (input) => {
						const event = input as PostToolBatchHookInput;
						const wikiCalls = event.tool_calls.filter((call) =>
							call.tool_name.startsWith("mcp__llm_wiki__"),
						);
						if (wikiCalls.length > 0) {
							send("tool_event", {
								phase: "batch",
								toolName: "mcp__llm_wiki__batch",
								toolCalls: wikiCalls.map((call) => ({
									toolName: call.tool_name,
									toolUseId: call.tool_use_id,
									inputPreview: previewToolInput(call.tool_input),
								})),
							});
						}
						return {};
					},
				],
			},
		],
		Stop: [
			{
				hooks: [
					async (input) => {
						const event = input as StopHookInput;
						send("agent_summary", {
							lastAssistantMessage: event.last_assistant_message,
							changedPaths: Array.from(context.changedPaths).sort(),
							toolCalls,
							failedToolCalls,
						});
						return {};
					},
				],
			},
		],
	};
}
