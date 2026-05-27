import type { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { AgentKillRequest, AgentMessage, AgentRequest } from "./types.js";
import { createLlmWikiMcpServer } from "./wiki-tools.js";

type QueryInput = Parameters<typeof sdkQuery>[0];
export type QueryFn = (input: QueryInput) => AsyncIterable<unknown>;

const READ_WIKI_TOOLS = [
	"mcp__llm_wiki__list_projects",
	"mcp__llm_wiki__list_pages",
	"mcp__llm_wiki__read_page",
	"mcp__llm_wiki__search_pages",
	"mcp__llm_wiki__get_graph",
] as const;

const WRITE_WIKI_TOOLS = [
	"mcp__llm_wiki__update_page",
	"mcp__llm_wiki__create_entity",
	"mcp__llm_wiki__create_concept",
] as const;

interface RequestHandlerDeps {
	queryFn: QueryFn;
	send: (msg: AgentMessage) => void;
	error?: (...args: unknown[]) => void;
	activeQueries?: Map<string, AbortController>;
	env?: NodeJS.ProcessEnv;
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
}: RequestHandlerDeps) {
	return async function handleRequest(
		req: AgentRequest | AgentKillRequest,
	): Promise<void> {
		if (req.type === "kill") {
			const ctrl = activeQueries.get(req.streamId);
			if (ctrl) {
				ctrl.abort();
				activeQueries.delete(req.streamId);
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
			const allowedTools = wikiToolsEnabled
				? [
						...READ_WIKI_TOOLS,
						...(enableWriteTools ? WRITE_WIKI_TOOLS : []),
					]
				: [];
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
							onWikiChanged: (payload) => {
								send({
									streamId: req.streamId,
									type: "wiki_changed",
									data: payload,
								});
							},
						}),
					}
				: undefined;

			const options = omitNullish({
				systemPrompt: req.options.systemPrompt,
				cwd: req.options.cwd,
				model: req.options.model,
				maxTurns: req.options.maxTurns ?? 10,
				maxBudgetUsd: req.options.maxBudgetUsd,
				persistSession: req.options.persistSession ?? false,
				tools: [],
				allowedTools,
				mcpServers,
				abortController,
				env,
			}) as QueryInput["options"];

			const q = queryFn({
				prompt: req.prompt,
				options,
			});

			for await (const message of q) {
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
