import type { QueryControl } from "./core.js";
import type { AgentMessage, RewindFilesRequest } from "./types.js";

interface RewindBridgeArgs {
	request: RewindFilesRequest;
	activeSdkQueries: Map<string, QueryControl>;
	send: (msg: AgentMessage) => void;
	onSettled?: () => void;
}

export function handleRewindFilesRequest({
	request,
	activeSdkQueries,
	send,
	onSettled,
}: RewindBridgeArgs): void {
	const activeQuery = activeSdkQueries.get(request.streamId);
	if (!activeQuery) {
		send({
			streamId: request.streamId,
			type: "rewind_files",
			data: {
				messageId: request.messageId,
				ok: false,
				error: "Agent stream is no longer active",
			},
		});
		onSettled?.();
		return;
	}
	if (!activeQuery.rewindFiles) {
		send({
			streamId: request.streamId,
			type: "rewind_files",
			data: {
				messageId: request.messageId,
				ok: false,
				error: "Active Agent query does not support file rewind",
			},
		});
		onSettled?.();
		return;
	}
	if (!request.messageId) {
		send({
			streamId: request.streamId,
			type: "rewind_files",
			data: {
				ok: false,
				error: "Missing SDK user message id",
			},
		});
		onSettled?.();
		return;
	}
	activeQuery.rewindFiles(request.messageId)
		.then((result) => {
			send({
				streamId: request.streamId,
				type: "rewind_files",
				data: {
					messageId: request.messageId,
					ok: result.canRewind,
					result,
					error: result.error,
				},
			});
		})
		.catch((err) => {
			send({
				streamId: request.streamId,
				type: "rewind_files",
				data: {
					messageId: request.messageId,
					ok: false,
					error: err instanceof Error ? err.message : String(err),
				},
			});
		})
		.finally(() => {
			onSettled?.();
		});
}
