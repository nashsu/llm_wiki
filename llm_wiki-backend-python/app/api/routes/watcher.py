"""API routes for file watching and web clipping services."""

from __future__ import annotations

import logging
from pathlib import Path
from urllib.parse import unquote

from fastapi import APIRouter, HTTPException

from app.services.clip_service import ClipNotFound, ClipService
from app.services.file_watcher import FileWatcher

logger = logging.getLogger("llm-wiki")

router = APIRouter(tags=["watcher"])

# In-memory registry of active file watchers keyed by project path
_watchers: dict[str, FileWatcher] = {}

_clip_svc = ClipService()


# ── Helpers ──────────────────────────────────────────────────────────


def _get_or_create_watcher(project_path: str) -> FileWatcher:
    """Return an existing watcher for *project_path* or create a new one.

    A no-op callback is used so callers can set their own later, but the
    typical usage is start/stop via the endpoints.
    """
    if project_path not in _watchers:
        _watchers[project_path] = FileWatcher(
            watch_dir=Path(project_path),
            callback=lambda event, path: logger.info(
                "File event: %s %s", event, path
            ),
        )
    return _watchers[project_path]


def _validate_project_path(project_path: str) -> Path:
    """Validate that *project_path* exists and is a directory.

    Returns the resolved path or raises HTTPException(404).
    """
    decoded = unquote(project_path)
    path = Path(decoded).resolve()
    if not path.is_dir():
        raise HTTPException(
            status_code=404,
            detail=f"Project directory not found: {decoded}",
        )
    return path


# ── Watcher Endpoints ───────────────────────────────────────────────


@router.post("/watcher/{project_path:path}/start")
async def start_watcher(project_path: str):
    """Start watching the project directory for file changes."""
    resolved = _validate_project_path(project_path)
    watcher = _get_or_create_watcher(str(resolved))
    if watcher.is_running:
        return {"status": "already_running", "project_path": str(resolved)}
    await watcher.start()
    logger.info("Watcher started for %s", resolved)
    return {"status": "started", "project_path": str(resolved)}


@router.post("/watcher/{project_path:path}/stop")
async def stop_watcher(project_path: str):
    """Stop watching the project directory."""
    resolved = _validate_project_path(project_path)
    key = str(resolved)
    watcher = _watchers.get(key)
    if watcher is None or not watcher.is_running:
        return {"status": "not_running", "project_path": str(resolved)}
    await watcher.stop()
    logger.info("Watcher stopped for %s", resolved)
    return {"status": "stopped", "project_path": str(resolved)}


@router.get("/watcher/{project_path:path}/status")
async def watcher_status(project_path: str):
    """Return the current status of the file watcher for a project."""
    resolved = _validate_project_path(project_path)
    key = str(resolved)
    watcher = _watchers.get(key)
    return {
        "project_path": str(resolved),
        "is_running": watcher.is_running if watcher else False,
    }


# ── Clip Endpoints ──────────────────────────────────────────────────


@router.post("/clip/{project_path:path}")
async def receive_clip(project_path: str, body: dict):
    """Receive a web clipping and save it to the project.

    Request body:
        ``url`` (str, required): Source URL.
        ``title`` (str, required): Page title.
        ``content`` (str, required): Markdown content.
    """
    resolved = _validate_project_path(project_path)
    url = body.get("url", "")
    title = body.get("title", "")
    content = body.get("content", "")

    if not url or not title or not content:
        raise HTTPException(
            status_code=422,
            detail="Missing required fields: url, title, content",
        )

    result = _clip_svc.receive_clip(
        project_path=str(resolved),
        content=content,
        url=url,
        title=title,
    )
    logger.info("Clip received: %s <- %s", result["file_path"], url)
    return result


@router.get("/clip/{project_path:path}/list")
async def list_clips(project_path: str):
    """List all saved clippings for a project."""
    resolved = _validate_project_path(project_path)
    clips = _clip_svc.list_clips(project_path=str(resolved))
    return {"clips": clips}


@router.delete("/clip/{project_path:path}/{clip_id}")
async def delete_clip(project_path: str, clip_id: str):
    """Delete a clipping by its ID (filename without extension)."""
    resolved = _validate_project_path(project_path)
    try:
        _clip_svc.delete_clip(project_path=str(resolved), clip_id=clip_id)
    except ClipNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    logger.info("Clip deleted: %s from %s", clip_id, resolved)
    return {"status": "deleted", "clip_id": clip_id}
