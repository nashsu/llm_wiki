/**
 * Subset of SDKMessage types the frontend cares about.
 * The sidecar emits full SDKMessage JSON; we only type the fields we use.
 */

export interface SDKTextBlock {
	type: "text";
	text: string;
}

export interface SDKToolUseBlock {
	type: "tool_use";
	id: string;
	name: string;
	input: Record<string, unknown>;
}

export interface SDKToolResultBlock {
	type: "tool_result";
	tool_use_id: string;
	content: string | SDKTextBlock[];
}

export type SDKContentBlock =
	| SDKTextBlock
	| SDKToolUseBlock
	| SDKToolResultBlock;

export interface SDKAssistantMessage {
	type: "assistant";
	message: {
		role: "assistant";
		content: SDKContentBlock[];
		model?: string;
		usage?: {
			input_tokens: number;
			output_tokens: number;
		};
	};
}

export interface SDKResultMessage {
	type: "result";
	result: string;
	subtype?: string;
	session_id?: string;
	cost_usd?: number;
	total_cost_usd?: number;
	duration_ms?: number;
	duration_api_ms?: number;
	num_turns?: number;
	usage?: {
		input_tokens: number;
		output_tokens: number;
	};
}

export interface SDKSystemMessage {
	type: "system";
	subtype?: string;
	message?: string;
	[key: string]: unknown;
}

export interface SDKErrorMessage {
	type: "error";
	error: string;
}

export type SDKMessage =
	| SDKAssistantMessage
	| SDKResultMessage
	| SDKSystemMessage
	| SDKErrorMessage
	| { type: string; [key: string]: unknown };

export interface AgentDonePayload {
	code: number;
	stderr?: string;
}

export interface AgentTransportOptions {
	systemPrompt?: string;
	cwd?: string;
	model?: string;
	maxTurns?: number;
	maxBudgetUsd?: number;
	apiKey?: string;
	baseUrl?: string;
}

export interface AgentCallbacks {
	onMessage: (msg: SDKMessage) => void;
	onToken: (text: string) => void;
	onDone: (result: SDKResultMessage | null) => void;
	onError: (err: Error) => void;
}
