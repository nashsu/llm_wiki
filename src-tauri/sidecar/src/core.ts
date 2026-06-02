import type { CanUseTool, query as sdkQuery, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AppToolBridge } from "./app-tool-bridge.js";
import type { PermissionBridge } from "./permission-bridge.js";
import type { AgentKillRequest, AgentMessage, AgentRequest } from "./types.js";
import { createLlmWikiHooks } from "./agent-hooks.js";
import {
	buildPermissionOptions,
	getAllowedWikiTools,
	isWikiToolName,
	shouldAllowWikiTool,
	type AgentPermissionPolicy,
} from "./agent-policy.js";
import { createLlmWikiMcpServer } from "./wiki-tools.js";

type QueryInput = Parameters<typeof sdkQuery>[0];
export type QueryFn = (input: QueryInput) => AsyncIterable<SDKMessage | { type: string; [k: string]: unknown }>;

interface RequestHandlerDeps {
	queryFn: QueryFn;
	send: (msg: AgentMessage) => void;
	error?: (...args: unknown[]) => void;
	activeQueries?: Map<string, AbortController>;
	env?: NodeJS.ProcessEnv;
	appToolBridge?: AppToolBridge;
	permissionBridge?: PermissionBridge;
}

export function omitNullish<T extends Record<string, unknown>>(
	value: T,
): Partial<T> {
	return Object.fromEntries(
		Object.entries(value).filter(([, item]) => item !== null && item !== undefined),
	) as Partial<T>;
}

export function createRequestHandler({
	queryFn,
	send,
	error = console.error,
	activeQueries = new Map<string, AbortController>(),
	env: baseEnv = process.env,
	appToolBridge,
	permissionBridge,
}: RequestHandlerDeps) {
	return async function handleRequest(
		req: AgentRequest | AgentKillRequest,
	): Promise<void> {
		if (req.type === "kill") {
			const ctrl = activeQueries.get(req.streamId);
			if (ctrl) {
				ctrl.abort();
				activeQueries.delete(req.streamId);
				appToolBridge?.rejectStream(req.streamId, "Agent stream was killed");
				permissionBridge?.rejectStream(req.streamId, "Agent stream was killed");
			}
			return;
		}

		const abortController = new AbortController();
		activeQueries.set(req.streamId, abortController);

		const env: Record<string, string | undefined> = { ...baseEnv };
		if (req.options.apiKey) env.ANTHROPIC_API_KEY = req.options.apiKey;
		if (req.options.baseUrl) env.ANTHROPIC_BASE_URL = req.options.baseUrl;

		try {
			const enableWikiTools = req.options.enableWikiTools !== false;
			const enableWriteTools = req.options.enableWriteTools !== false;
			const wikiToolsEnabled = enableWikiTools && Boolean(req.options.projectPath);
			const permissionPolicy: AgentPermissionPolicy =
				req.options.permissionPolicy ?? "default";
			const changedPaths = new Set<string>();
			const allowedTools = getAllowedWikiTools({
				wikiToolsEnabled,
				enableWriteTools,
			});
			const mcpServers = wikiToolsEnabled
				? {
						llm_wiki: createLlmWikiMcpServer({
							baseUrl: req.options.apiServerBaseUrl,
							token: req.options.apiToken,
							projectId: req.options.projectId,
							projectPath: req.options.projectPath,
							enableWriteTools,
							maxWriteBytes: req.options.maxWriteBytes,
							maxFilesChanged: req.options.maxFilesChanged,
							changedPaths,
							streamId: req.streamId,
							appToolBridge,
							emitAgentEvent: (type, data) => {
								send({ streamId: req.streamId, type: type as AgentMessage["type"], data });
							},
							onWikiChanged: (payload) => {
								changedPaths.add(payload.path);
								send({
									streamId: req.streamId,
									type: "wiki_changed",
									data: payload,
								});
								send({
									streamId: req.streamId,
									type: "agent_action_required",
									data: {
										kind: "lint_recommended",
										paths: [payload.path],
										reason: "agent_write",
									},
								});
							},
						}),
					}
				: undefined;
			const hooks = createLlmWikiHooks({
				streamId: req.streamId,
				enableWriteTools,
				permissionPolicy,
				changedPaths,
				send,
			});

			const canUseTool: CanUseTool | undefined = permissionBridge
				? async (toolName, input, options) => {
						if (isWikiToolName(toolName)) {
							const decision = shouldAllowWikiTool({
								toolName,
								enableWriteTools,
							});
							if (decision.allowed) {
								return {
									behavior: "allow" as const,
									toolUseID: options.toolUseID,
								};
							}
							return {
								behavior: "deny" as const,
								message: decision.reason,
								toolUseID: options.toolUseID,
							};
						}
						return permissionBridge.requestPermission(
							req.streamId,
							toolName,
							input,
							options,
						);
					}
				: undefined;
			const rawOptions: Record<string, unknown> = {
				systemPrompt: req.options.systemPrompt,
				cwd: req.options.cwd,
				model: req.options.model,
				maxTurns: req.options.maxTurns ?? 10,
				maxBudgetUsd: req.options.maxBudgetUsd,
				sessionId: req.options.sessionId,
				resume: req.options.resume,
				continue: req.options.continue,
				forkSession: req.options.forkSession,
				resumeSessionAt: req.options.resumeSessionAt,
				persistSession: req.options.persistSession ?? false,
				title: req.options.title,
				enableFileCheckpointing: req.options.enableFileCheckpointing,
				sandbox: req.options.sandbox,
				...buildPermissionOptions(permissionPolicy),
				allowedTools,
				canUseTool,
				mcpServers,
				hooks,
				abortController,
				env,

				// PR D: structured output
				outputFormat: req.options.outputFormat,

				// PR D: thinking / effort / taskBudget
				thinking: req.options.thinking,
				effort: req.options.effort,
				taskBudget: req.options.taskBudget,

				// PR D: event passthrough
				includePartialMessages: req.options.includePartialMessages,
				includeHookEvents: req.options.includeHookEvents,
				promptSuggestions: req.options.promptSuggestions,
				agentProgressSummaries: req.options.agentProgressSummaries,
				forwardSubagentText: req.options.forwardSubagentText,
				// PR E: subagents + skills + plugins
				agentName: req.options.agentName,
				agents: req.options.agents,
				skills: req.options.skills,
				plugins: req.options.plugins,
			};
			const options = omitNullish(rawOptions) as QueryInput["options"];

			const q = queryFn({
				prompt: req.prompt,
				options,
			});

			for await (const message of q) {
				const msg = message as SDKMessage;

				// PR D: emit SDK native events separately so frontend can route them
				if (req.options.promptSuggestions && msg.type === "prompt_suggestion" && "suggestion" in msg) {
					send({ streamId: req.streamId, type: "prompt_suggestion", data: msg });
				}
				if (req.options.agentProgressSummaries && msg.type === "result" && "agentProgressSummaries" in msg) {
					send({ streamId: req.streamId, type: "agent_progress_summary", data: (msg as any).agentProgressSummaries });
				}

				if (req.options.includePartialMessages && msg?.type === "partial_message") {
					send({ streamId: req.streamId, type: "partial_message", data: msg });
					continue;
				}
				if (req.options.includeHookEvents && msg?.type === "hook_event") {
					send({ streamId: req.streamId, type: "hook_event", data: msg });
					continue;
				}
				if (req.options.forwardSubagentText && msg?.type === "subagent_event") {
					send({ streamId: req.streamId, type: "subagent_event", data: msg });
					continue;
				}

				send({ streamId: req.streamId, type: "message", data: message });
			}

			send({ streamId: req.streamId, type: "done", data: null });
		} catch (err) {
			error("[sidecar] query error:", err);
			send({
				streamId: req.streamId,
				type: "error",
				data: {
					error: err instanceof Error ? err.message : String(err),
					stack: err instanceof Error ? err.stack : undefined,
				},
			});
		} finally {
			activeQueries.delete(req.streamId);
		}
	};
}
