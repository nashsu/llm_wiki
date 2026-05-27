import { query } from "@anthropic-ai/claude-agent-sdk";
import { createInterface } from "readline";
import { createRequestHandler } from "./core.js";
import type { AgentKillRequest, AgentMessage, AgentRequest } from "./types.js";

const rl = createInterface({ input: process.stdin });
const activeQueries = new Map<string, AbortController>();

function send(msg: AgentMessage): void {
	process.stdout.write(JSON.stringify(msg) + "\n");
}

const handleRequest = createRequestHandler({
	queryFn: query,
	send,
	error: console.error,
	activeQueries,
});

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

// Keep process alive even after stdin EOF — active queries hold refs.
// When all queries finish and stdin is closed, exit cleanly.
rl.on("close", () => {
	// Don't exit immediately — active query() generators keep the event loop alive.
	// This setInterval prevents Node from exiting while queries are running.
	const keepAlive = setInterval(() => {}, 60000);
	const check = setInterval(() => {
		if (activeQueries.size === 0) {
			clearInterval(keepAlive);
			clearInterval(check);
			process.exit(0);
		}
	}, 1000);
});

console.error("[sidecar] ready");
