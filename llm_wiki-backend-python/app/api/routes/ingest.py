"""Ingestion API routes — queue management and cache inspection."""

import os
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.core.ingest.cache import IngestCache
from app.core.ingest.queue import IngestQueue

router = APIRouter(prefix="/ingest", tags=["ingest"])

# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------


class EnqueueRequest(BaseModel):
    source_path: str


class EnqueueBatchSource(BaseModel):
    source_path: str


class EnqueueBatchRequest(BaseModel):
    sources: list[EnqueueBatchSource]


class EnqueueResponse(BaseModel):
    task_id: str


class EnqueueBatchResponse(BaseModel):
    task_ids: list[str]


class CacheStatusResponse(BaseModel):
    source_id: str
    status: str
    cached: bool
    files_written: list[str] = []


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _get_queue(project_path: str) -> IngestQueue:
    """Return an IngestQueue scoped to *project_path*."""
    queue_dir = Path(project_path) / ".llm-wiki" / "queue"
    return IngestQueue(queue_dir)


def _get_cache(project_path: str) -> IngestCache:
    """Return an IngestCache scoped to *project_path*."""
    cache_dir = Path(project_path) / ".llm-wiki" / "cache"
    return IngestCache(cache_dir)


# ---------------------------------------------------------------------------
# Queue endpoints
# ---------------------------------------------------------------------------


@router.post("/{project_path:path}/enqueue")
async def enqueue(project_path: str, req: EnqueueRequest) -> EnqueueResponse:
    """Enqueue a single source file for ingestion."""
    if not os.path.isdir(project_path):
        raise HTTPException(
            status_code=404,
            detail=f"Project not found: {project_path}",
        )
    queue = _get_queue(project_path)
    task_id = queue.enqueue(req.source_path, project_path)
    return EnqueueResponse(task_id=task_id)


@router.post("/{project_path:path}/enqueue-batch")
async def enqueue_batch(
    project_path: str,
    req: EnqueueBatchRequest,
) -> EnqueueBatchResponse:
    """Enqueue multiple source files for ingestion."""
    if not os.path.isdir(project_path):
        raise HTTPException(
            status_code=404,
            detail=f"Project not found: {project_path}",
        )
    queue = _get_queue(project_path)
    sources = [(s.source_path, project_path) for s in req.sources]
    task_ids = queue.enqueue_batch(sources)
    return EnqueueBatchResponse(task_ids=task_ids)


@router.get("/{project_path:path}/queue")
async def list_queue(
    project_path: str,
    status: str | None = None,
) -> list[dict[str, Any]]:
    """List all queue tasks, optionally filtered by *status*."""
    queue = _get_queue(project_path)
    return queue.list_tasks(status=status)


@router.get("/{project_path:path}/queue/{task_id}")
async def get_task_status(
    project_path: str,
    task_id: str,
) -> dict[str, Any]:
    """Get the status of a specific task."""
    queue = _get_queue(project_path)
    status = queue.get_status(task_id)
    if status.get("status") == "not_found":
        raise HTTPException(
            status_code=404,
            detail=f"Task not found: {task_id}",
        )
    return status


@router.delete("/{project_path:path}/queue/{task_id}")
async def cancel_task(
    project_path: str,
    task_id: str,
) -> dict[str, str]:
    """Cancel a pending or processing task."""
    queue = _get_queue(project_path)
    status = queue.get_status(task_id)
    if status.get("status") == "not_found":
        raise HTTPException(
            status_code=404,
            detail=f"Task not found: {task_id}",
        )
    queue.cancel(task_id)
    return {"status": "cancelled"}


@router.post("/{project_path:path}/queue/{task_id}/retry")
async def retry_task(
    project_path: str,
    task_id: str,
) -> dict[str, str]:
    """Reset a failed task to pending for retry."""
    queue = _get_queue(project_path)
    status = queue.get_status(task_id)
    if status.get("status") == "not_found":
        raise HTTPException(
            status_code=404,
            detail=f"Task not found: {task_id}",
        )
    if status.get("status") != "failed":
        raise HTTPException(
            status_code=400,
            detail="Only failed tasks can be retried",
        )
    queue.retry(task_id)
    return {"status": "pending"}


# ---------------------------------------------------------------------------
# Cache endpoints
# ---------------------------------------------------------------------------


@router.get("/{project_path:path}/cache/{source_id:path}")
async def get_cache_status(
    project_path: str,
    source_id: str,
) -> CacheStatusResponse:
    """Inspect the cache state for a source file."""
    cache = _get_cache(project_path)
    files_written = cache.get_files_written(source_id)
    return CacheStatusResponse(
        source_id=source_id,
        status="cached" if files_written else "not_cached",
        cached=bool(files_written),
        files_written=files_written,
    )
