import { query } from "@anthropic-ai/claude-agent-sdk";
import { createInterface } from "readline";
import { createAppToolBridge, type AppToolResponseMessage } from "./app-tool-bridge.js";
import { createRequestHandler } from "./core.js";
import {
	createPermissionBridge,
	type AgentPermissionResponseMessage,
} from "./permission-bridge.js";
import type { AgentKillRequest, AgentMessage, AgentRequest } from "./types.js";

const rl = createInterface({ input: process.stdin });
const activeQueries = new Map<string, AbortController>();
let exitTimer: NodeJS.Timeout | undefined;

function send(msg: AgentMessage): void {
	process.stdout.write(JSON.stringify(msg) + "\n");
}

function cancelScheduledExit(): void {
	if (!exitTimer) return;
	clearTimeout(exitTimer);
	exitTimer = undefined;
}

function scheduleExitIfIdle(): void {
	if (activeQueries.size !== 0 || exitTimer) return;
	exitTimer = setTimeout(() => {
		exitTimer = undefined;
		if (activeQueries.size === 0) process.exit(0);
	}, 250);
}

const appToolBridge = createAppToolBridge({ send });
const permissionBridge = createPermissionBridge({ send });
const handleRequest = createRequestHandler({
	queryFn: query,
	send,
	error: console.error,
	activeQueries,
	appToolBridge,
	permissionBridge,
});

rl.on("line", (line) => {
	try {
		cancelScheduledExit();
		const parsed = JSON.parse(line) as
			| AgentRequest
			| AgentKillRequest
			| AppToolResponseMessage
			| AgentPermissionResponseMessage;
		if (parsed.type === "app_tool_response") {
			appToolBridge.handleResponse(parsed);
			return;
		}
		if (parsed.type === "permission_response") {
			permissionBridge.handleResponse(parsed);
			return;
		}
		handleRequest(parsed).catch((err) => {
			console.error("[sidecar] unhandled error:", err);
		}).finally(() => {
			scheduleExitIfIdle();
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
			scheduleExitIfIdle();
		}
	}, 1000);
});

console.error("[sidecar] ready");
