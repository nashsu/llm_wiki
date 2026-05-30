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
		sessionId?: string;
		resume?: string;
		continue?: boolean;
		forkSession?: boolean;
		resumeSessionAt?: string;
		apiKey?: string;
		baseUrl?: string;
		persistSession?: boolean;
		title?: string;
		allowedTools?: string[];
		permissionPolicy?:
			| "default"
			| "restricted"
			| "bypass"
			| "acceptEdits"
			| "bypassPermissions"
			| "plan"
			| "dontAsk"
			| "auto";
		projectId?: string;
		projectPath?: string;
		apiServerBaseUrl?: string;
		apiToken?: string;
		enableWikiTools?: boolean;
		enableWriteTools?: boolean;
		maxWriteBytes?: number;
		maxFilesChanged?: number;
		enableFileCheckpointing?: boolean;
		sandbox?: {
			enabled?: boolean;
			autoAllowBashIfSandboxed?: boolean;
			failIfUnavailable?: boolean;
			network?: Record<string, unknown>;
		};

		// PR D: structured output
		outputFormat?:
			| { type: "json_schema"; schema: Record<string, unknown> };

		// PR D: thinking / effort / taskBudget
		thinking?:
			| { type: "adaptive" }
			| { type: "enabled"; budgetTokens: number }
			| { type: "disabled" };
		effort?: "low" | "medium" | "high" | "xhigh" | "max";
		taskBudget?: { total: number };

		// PR D: event passthrough
		includePartialMessages?: boolean;
		includeHookEvents?: boolean;
		promptSuggestions?: boolean;
		agentProgressSummaries?: boolean;
		forwardSubagentText?: boolean;
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

export interface RewindFilesRequest {
	type: "rewind_files";
	streamId: string;
	messageId?: string;
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
		| "agent_permission_request"
		| "agent_task_started"
		| "agent_task_progress"
		| "agent_task_done"
		| "agent_task_error"
		| "rewind_files"
		| "prompt_suggestion"
		| "partial_message"
		| "hook_event"
		| "subagent_event"
		| "agent_progress_summary";
	data: unknown;
}
