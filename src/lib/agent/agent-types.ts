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

export interface AgentWikiChangedPayload {
	path: string;
	operation: "update" | "create" | "delete";
	oldSha256?: string;
	newSha256?: string;
}

export interface AgentToolEventPayload {
	phase: "pre" | "post" | "failure" | "batch";
	toolName: string;
	toolUseId?: string;
	ok?: boolean;
	durationMs?: number;
	inputPreview?: Record<string, unknown>;
	error?: string;
	permissionPolicy?: "default" | "restricted" | "bypass";
	toolCalls?: Array<{
		toolName: string;
		toolUseId?: string;
		inputPreview?: Record<string, unknown>;
	}>;
}

export interface AgentSummaryPayload {
	lastAssistantMessage?: string;
	changedPaths: string[];
	toolCalls: number;
	failedToolCalls: number;
}

export interface AgentActionRequiredPayload {
	kind: "lint_recommended";
	paths: string[];
	reason: "agent_write";
}

export interface AgentTaskEventPayload {
	taskId: string;
	toolName: string;
	message?: string;
	progress?: number;
	result?: unknown;
	error?: string;
}

export interface AgentAppToolRequestPayload {
	requestId: string;
	toolName: string;
	args: Record<string, unknown>;
}

export interface AgentTransportOptions {
	systemPrompt?: string;
	cwd?: string;
	model?: string;
	maxTurns?: number;
	maxBudgetUsd?: number;
	sessionId?: string;
	resume?: string;
	continueSession?: boolean;
	forkSession?: boolean;
	resumeSessionAt?: string;
	persistSession?: boolean;
	title?: string;
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
}

export interface AgentCallbacks {
	onMessage: (msg: SDKMessage) => void;
	onToken: (text: string) => void;
	onDone: (result: SDKResultMessage | null) => void;
	onError: (err: Error) => void;
	onWikiChanged?: (payload: AgentWikiChangedPayload) => void;
	onToolEvent?: (payload: AgentToolEventPayload) => void;
	onAgentSummary?: (payload: AgentSummaryPayload) => void;
	onActionRequired?: (payload: AgentActionRequiredPayload) => void;
	onTaskEvent?: (type: string, payload: AgentTaskEventPayload) => void;
}
