export interface AgentRequest {
	type: "query";
	streamId: string;
	prompt: string;
	options: {
		systemPrompt?: string;
		cwd?: string;
		model?: string;
		maxTurns?: number;
		maxBudgetUsd?: number;
		apiKey?: string;
		baseUrl?: string;
		persistSession?: boolean;
		allowedTools?: string[];
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
}

export interface AgentKillRequest {
	type: "kill";
	streamId: string;
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

export interface AgentMessage {
	streamId: string;
	type:
		| "message"
		| "error"
		| "done"
		| "app_tool_request"
		| "wiki_changed"
		| "tool_event"
		| "agent_summary"
		| "agent_action_required"
		| "agent_task_started"
		| "agent_task_progress"
		| "agent_task_done"
		| "agent_task_error";
	data: unknown;
}
