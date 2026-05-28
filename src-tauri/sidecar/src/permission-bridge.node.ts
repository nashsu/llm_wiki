import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "./types.js";
import {
	createPermissionBridge,
	type AgentPermissionResponseMessage,
} from "./permission-bridge.js";

function response(
	requestId: string,
	decision: AgentPermissionResponseMessage["decision"],
): AgentPermissionResponseMessage {
	return {
		type: "permission_response",
		streamId: "stream-1",
		requestId,
		ok: true,
		decision,
	};
}

test("permission bridge emits request and resolves allow decision", async () => {
	const sent: AgentMessage[] = [];
	const bridge = createPermissionBridge({
		send: (msg) => sent.push(msg),
	});

	const pending = bridge.requestPermission(
		"stream-1",
		"Bash",
		{ command: "pwd", contents: "secret" },
		{
			signal: new AbortController().signal,
			toolUseID: "tool-1",
			title: "Claude wants to run Bash",
			displayName: "Run command",
			description: "pwd",
		},
	);

	assert.equal(sent.length, 1);
	assert.equal(sent[0]?.type, "agent_permission_request");
	const payload = sent[0]?.data as {
		requestId: string;
		inputPreview: Record<string, unknown>;
	};
	assert.equal(payload.inputPreview.command, undefined);
	assert.equal(payload.inputPreview.contents, undefined);
	assert.equal(typeof payload.inputPreview.contentsSha256, "string");

	bridge.handleResponse(
		response(payload.requestId, {
			behavior: "allow",
			updatedInput: { command: "pwd" },
		}),
	);

	assert.deepEqual(await pending, {
		behavior: "allow",
		updatedInput: { command: "pwd" },
		updatedPermissions: undefined,
		toolUseID: "tool-1",
		decisionClassification: undefined,
	});
});

test("permission bridge resolves deny decisions and rejects killed streams", async () => {
	const sent: AgentMessage[] = [];
	const bridge = createPermissionBridge({
		send: (msg) => sent.push(msg),
	});

	const denied = bridge.requestPermission(
		"stream-1",
		"Edit",
		{ file_path: "/tmp/wiki.md" },
		{
			signal: new AbortController().signal,
			toolUseID: "tool-2",
		},
	);
	const denyPayload = sent[0]?.data as { requestId: string };
	bridge.handleResponse(
		response(denyPayload.requestId, {
			behavior: "deny",
			reason: "No",
		}),
	);
	assert.deepEqual(await denied, {
		behavior: "deny",
		message: "No",
		interrupt: undefined,
		toolUseID: "tool-2",
		decisionClassification: undefined,
	});

	const killed = bridge.requestPermission(
		"stream-1",
		"Bash",
		{},
		{
			signal: new AbortController().signal,
			toolUseID: "tool-3",
		},
	);
	bridge.rejectStream("stream-1", "killed");
	await assert.rejects(killed, /killed/);
});

test("permission bridge auto-denies timed out requests", async () => {
	const bridge = createPermissionBridge({
		send: () => {},
		timeoutMs: 1,
	});

	const result = await bridge.requestPermission(
		"stream-1",
		"Bash",
		{},
		{
			signal: new AbortController().signal,
			toolUseID: "tool-4",
		},
	);

	assert.deepEqual(result, {
		behavior: "deny",
		message: "Permission request timed out: Bash",
		toolUseID: "tool-4",
	});
});
