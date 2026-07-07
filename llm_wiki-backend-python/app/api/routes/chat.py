"""Chat API routes — synchronous and SSE streaming endpoints.

Endpoints
---------
- ``POST /api/chat/{project_path}/send`` — synchronous chat
- ``POST /api/chat/{project_path}/stream`` — SSE streaming chat
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any
from urllib.parse import unquote

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

logger = logging.getLogger("llm-wiki")

router = APIRouter(prefix="/chat", tags=["chat"])


# ── Request / Response models ──────────────────────────────────────


class ChatRequest(BaseModel):
    """Request body for chat endpoints."""

    message: str
    history: list[dict[str, str]] | None = None


class ChatResponse(BaseModel):
    """Response body for the synchronous chat endpoint."""

    response: str


# ── Agent registry (simple in-memory cache) ────────────────────────

_agent_registry: dict[str, Any] = {}


def _get_agent(project_path: str) -> Any:
    """Get or create a WikiChatAgent for the given project.

    In a production setup this would be looked up from a proper registry
    or created per-request with the correct LLM and prompt manager.
    """
    if project_path not in _agent_registry:
        raise HTTPException(
            status_code=404,
            detail=f"No agent initialised for project: {project_path}",
        )
    return _agent_registry[project_path]


# ── Endpoints ──────────────────────────────────────────────────────


def _validate_project(project_path: str) -> Path:
    """Validate that *project_path* points to a valid Wiki project.

    Returns the resolved ``Path``.
    """
    decoded = unquote(project_path)
    root = Path(decoded).resolve()
    if not root.is_dir():
        raise HTTPException(
            status_code=404,
            detail=f"Project not found: {decoded}",
        )
    return root


@router.post("/{project_path:path}/send")
async def chat_send(project_path: str, body: ChatRequest) -> ChatResponse:
    """Synchronous chat endpoint.

    Sends a message to the Wiki Chat Agent and returns the full response.
    """
    _validate_project(project_path)
    agent = _get_agent(project_path)

    try:
        response = agent.chat(message=body.message, history=body.history)
        return ChatResponse(response=response)
    except Exception as exc:
        logger.exception("Chat error for %s", project_path)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/{project_path:path}/stream")
async def chat_stream(project_path: str, body: ChatRequest):
    """Streaming chat endpoint (SSE).

    Returns a ``text/event-stream`` response where each event is a JSON
    line with the format::

        data: {"type": "token", "content": "..."}
        data: {"type": "tool_start", "name": "search_wiki"}
        data: {"type": "tool_end", "name": "search_wiki"}
        data: {"type": "done"}
    """
    _validate_project(project_path)
    agent = _get_agent(project_path)

    async def event_generator():
        try:
            async for token in agent.stream_chat(
                message=body.message,
                history=body.history,
            ):
                # Determine event type from token prefix
                if token.startswith("[Using tool: "):
                    tool_name = token.removeprefix("[Using tool: ").removesuffix("]")
                    event = {"type": "tool_start", "name": tool_name}
                elif token.startswith("[Tool completed: "):
                    tool_name = token.removeprefix("[Tool completed: ").removesuffix("]")
                    event = {"type": "tool_end", "name": tool_name}
                else:
                    event = {"type": "token", "content": token}

                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"

            # Signal completion
            yield f"data: {json.dumps({'type': 'done'})}\n\n"

        except Exception as exc:
            logger.exception("Streaming error for %s", project_path)
            error_event = {"type": "error", "content": str(exc)}
            yield f"data: {json.dumps(error_event, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps({'type': 'done'})}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
