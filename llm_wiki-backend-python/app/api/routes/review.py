"""Review API routes — scan pages and manage the review queue.

Endpoints
---------
- ``GET  /api/review/{project_path:path}/list[?status=]``
- ``POST /api/review/{project_path:path}/scan``
- ``POST /api/review/{project_path:path}/scan-all``
- ``POST /api/review/{project_path:path}/{review_id}/resolve``
- ``POST /api/review/{project_path:path}/{review_id}/dismiss``
- ``GET  /api/review/{project_path:path}/stats``
"""

import json
import logging
import os
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.core.llm.factory import LLMFactory
from app.core.prompts.manager import PromptManager
from app.core.review.engine import ReviewEngine
from app.core.review.queue import ReviewQueue
from app.models.config import ProjectConfig, ProjectSecrets

logger = logging.getLogger("llm-wiki")

router = APIRouter(prefix="/review", tags=["review"])

# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------


class ScanRequest(BaseModel):
    page_path: str


class ResolveRequest(BaseModel):
    action: str
    note: str = ""


class DismissRequest(BaseModel):
    note: str = ""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _get_queue(project_path: str) -> ReviewQueue:
    """Return a ReviewQueue scoped to *project_path*."""
    queue_dir = Path(project_path) / ".llm-wiki" / "review"
    return ReviewQueue(queue_dir)


def _get_engine(project_path: str) -> ReviewEngine:
    """Create a ReviewEngine for the given project.

    Loads the project configuration, resolves the LLM for the
    ``"maintenance"`` feature (falling back to ``"ingest"``), and
    returns a configured engine.
    """
    project = Path(project_path)
    config_file = project / ".llm-wiki" / "config.json"

    if not config_file.is_file():
        raise HTTPException(
            status_code=404,
            detail=f"Project config not found: {project_path}",
        )

    try:
        raw = config_file.read_text(encoding="utf-8")
        config_data = json.loads(raw)
        project_config = ProjectConfig(**config_data)
    except (json.JSONDecodeError, Exception) as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid project config: {exc}",
        )

    secrets: ProjectSecrets = project_config.secrets
    providers_map = {p.id: p for p in secrets.providers}
    assignment = secrets.assignment

    # Try maintenance provider first, fall back to ingest
    llm = None
    for feature in ("maintenance", "ingest"):
        try:
            llm = LLMFactory.create_for_feature(assignment, providers_map, feature)
            break
        except ValueError:
            continue

    if llm is None:
        raise HTTPException(
            status_code=400,
            detail="No LLM provider configured for review scanning. "
            "Please configure a maintenance or ingest provider.",
        )

    prompt_manager = PromptManager(project_path=project)
    engine = ReviewEngine(
        llm=llm,
        prompt_manager=prompt_manager,
        wiki_path=project,
    )
    return engine


def _project_exists(project_path: str) -> None:
    """Raise 404 if the project directory does not exist."""
    if not os.path.isdir(project_path):
        raise HTTPException(
            status_code=404,
            detail=f"Project not found: {project_path}",
        )


# ---------------------------------------------------------------------------
# Scan endpoints
# ---------------------------------------------------------------------------


@router.post("/{project_path:path}/scan")
async def scan_page(project_path: str, req: ScanRequest) -> list[dict[str, Any]]:
    """Scan a single wiki page and return review items."""
    _project_exists(project_path)
    engine = _get_engine(project_path)
    items = engine.scan_page(req.page_path)
    return items


@router.post("/{project_path:path}/scan-all")
async def scan_all_pages(project_path: str) -> dict[str, Any]:
    """Scan all wiki pages and enqueue review items."""
    _project_exists(project_path)
    engine = _get_engine(project_path)
    items = engine.scan_all_pages()

    queue = _get_queue(project_path)
    review_ids: list[str] = []
    for item in items:
        review_id = queue.add(item)
        review_ids.append(review_id)

    return {
        "total_items": len(items),
        "enqueued": len(review_ids),
        "review_ids": review_ids,
    }


# ---------------------------------------------------------------------------
# Queue management endpoints
# ---------------------------------------------------------------------------


@router.get("/{project_path:path}/list")
async def list_reviews(
    project_path: str,
    status: str | None = None,
) -> list[dict[str, Any]]:
    """List all review items, optionally filtered by *status*."""
    _project_exists(project_path)
    queue = _get_queue(project_path)
    return queue.list(status=status)


@router.post("/{project_path:path}/{review_id}/resolve")
async def resolve_review(
    project_path: str,
    review_id: str,
    req: ResolveRequest,
) -> dict[str, str]:
    """Mark a review item as resolved with the given action."""
    _project_exists(project_path)
    queue = _get_queue(project_path)

    try:
        queue.resolve(review_id, action=req.action, note=req.note)
    except KeyError:
        raise HTTPException(
            status_code=404,
            detail=f"Review item not found: {review_id}",
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    return {"status": "resolved"}


@router.post("/{project_path:path}/{review_id}/dismiss")
async def dismiss_review(
    project_path: str,
    review_id: str,
    req: DismissRequest,
) -> dict[str, str]:
    """Dismiss a review item without taking action."""
    _project_exists(project_path)
    queue = _get_queue(project_path)

    try:
        queue.dismiss(review_id, note=req.note)
    except KeyError:
        raise HTTPException(
            status_code=404,
            detail=f"Review item not found: {review_id}",
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    return {"status": "dismissed"}


@router.get("/{project_path:path}/stats")
async def review_stats(project_path: str) -> dict[str, int]:
    """Return aggregate statistics about the review queue."""
    _project_exists(project_path)
    queue = _get_queue(project_path)
    return queue.get_stats()
