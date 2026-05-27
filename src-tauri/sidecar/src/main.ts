import { query } from "@anthropic-ai/claude-agent-sdk";
import { createInterface } from "readline";
import type { AgentKillRequest, AgentMessage, AgentRequest } from "./types.js";

const rl = createInterface({ input: process.stdin });
const activeQueries = new Map<string, AbortController>();

function send(msg: AgentMessage): void {
	process.stdout.write(JSON.stringify(msg) + "\n");
}

async function handleRequest(
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

	const env: Record<string, string | undefined> = { ...process.env };
	if (req.options.apiKey) env.ANTHROPIC_API_KEY = req.options.apiKey;
	if (req.options.baseUrl) env.ANTHROPIC_BASE_URL = req.options.baseUrl;

	try {
		const q = query({
			prompt: req.prompt,
			options: {
				systemPrompt: req.options.systemPrompt,
				cwd: req.options.cwd,
				model: req.options.model,
				maxTurns: req.options.maxTurns ?? 10,
				maxBudgetUsd: req.options.maxBudgetUsd,
				persistSession: req.options.persistSession ?? false,
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
				abortController,
				env,
			},
		});

		for await (const message of q) {
			send({ streamId: req.streamId, type: "message", data: message });
		}

		send({ streamId: req.streamId, type: "done", data: null });
	} catch (err) {
		send({
			streamId: req.streamId,
			type: "error",
			data: { error: err instanceof Error ? err.message : String(err) },
		});
	} finally {
		activeQueries.delete(req.streamId);
	}
}

rl.on("line", (line) => {
	try {
		const req = JSON.parse(line) as AgentRequest | AgentKillRequest;
		handleRequest(req).catch((err) => {
			console.error("[sidecar] unhandled error:", err);
		});
	} catch {
		// ignore malformed input
	}
});

// Signal parent that sidecar is ready
send({ streamId: "", type: "done", data: { status: "ready" } });
