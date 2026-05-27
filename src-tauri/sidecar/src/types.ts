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
	};
}

export interface AgentKillRequest {
	type: "kill";
	streamId: string;
}

export interface AgentMessage {
	streamId: string;
	type: "message" | "error" | "done";
	data: unknown;
}
