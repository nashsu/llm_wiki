"""Lint API routes — structural and semantic checking of wiki projects.

Endpoints
---------
- ``GET /api/lint/{project_path:path}/check`` — run all lint checks
- ``GET /api/lint/{project_path:path}/structural`` — structural checks only
- ``POST /api/lint/{project_path:path}/fix`` — batch fix lint items
"""

from __future__ import annotations

import logging
from pathlib import Path
from urllib.parse import unquote

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.core.lint import LintEngine, LintFixer

logger = logging.getLogger("llm-wiki")

router = APIRouter(prefix="/lint", tags=["lint"])


# ── Request / Response models ──────────────────────────────────────────────


class FixRequest(BaseModel):
    """Request body for batch fix endpoint."""

    items: list[dict]


class FixResponse(BaseModel):
    """Response body for batch fix endpoint."""

    fixed_count: int
    remaining: list[dict]


# ── Helpers ────────────────────────────────────────────────────────────────


def _validate_project(project_path: str) -> Path:
    """Validate and resolve a project path.

    Returns:
        The resolved project root ``Path``.

    Raises:
        HTTPException: If the path does not point to a valid wiki project.
    """
    decoded = unquote(project_path)
    root = Path(decoded).resolve()
    if not root.is_dir():
        raise HTTPException(
            status_code=404,
            detail=f"Project not found: {decoded}",
        )
    wiki_dir = root / "wiki"
    schema_file = root / "schema.md"
    if not wiki_dir.is_dir() or not schema_file.is_file():
        raise HTTPException(
            status_code=400,
            detail=f"Invalid wiki project at {decoded}: missing wiki/ or schema.md",
        )
    return root


def _build_engine(project_root: Path) -> LintEngine:
    """Create a :class:`LintEngine` for the given project root."""
    return LintEngine(
        wiki_path=project_root / "wiki",
        schema_path=project_root / "schema.md",
    )


def _build_fixer(project_root: Path) -> LintFixer:
    """Create a :class:`LintFixer` for the given project root."""
    return LintFixer(wiki_path=project_root / "wiki")


# ── Endpoints ──────────────────────────────────────────────────────────────


@router.get("/{project_path:path}/check")
async def run_all_checks(project_path: str) -> dict:
    """Run all lint checks (structural + semantic).

    Semantic checks that require an LLM are skipped in this endpoint.
    Use ``POST .../check`` with an ``llm_call`` parameter for full checks.
    """
    root = _validate_project(project_path)
    engine = _build_engine(root)
    try:
        results = engine.run_all()
        return results
    except Exception as exc:
        logger.exception("Lint check failed for %s", project_path)
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/{project_path:path}/structural")
async def run_structural_checks(project_path: str) -> dict:
    """Run structural (rule-based) checks only."""
    root = _validate_project(project_path)
    engine = _build_engine(root)
    try:
        items = engine.run_structural_checks()
        return {"structural": items}
    except Exception as exc:
        logger.exception("Structural lint check failed for %s", project_path)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/{project_path:path}/fix", response_model=FixResponse)
async def batch_fix(project_path: str, body: FixRequest) -> FixResponse:
    """Batch‑fix lint items.

    Accepts a list of lint items and attempts to auto‑fix them. Returns
    the count of fixed items and the list of items that could not be
    fixed automatically.
    """
    root = _validate_project(project_path)
    fixer = _build_fixer(root)
    try:
        remaining = fixer.batch_fix(body.items)
        fixed_count = len(body.items) - len(remaining)
        return FixResponse(fixed_count=fixed_count, remaining=remaining)
    except Exception as exc:
        logger.exception("Batch fix failed for %s", project_path)
        raise HTTPException(status_code=500, detail=str(exc))
