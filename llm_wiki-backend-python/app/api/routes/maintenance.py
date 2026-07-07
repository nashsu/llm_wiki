"""Maintenance API routes — three-phase safety workflow endpoints.

Endpoints
---------
- ``POST /api/maintenance/{project_path}/investigate`` — Phase 1: read-only investigation
- ``POST /api/maintenance/{project_path}/preview`` — Phase 2: dry-run preview
- ``POST /api/maintenance/{project_path}/execute`` — Phase 3: confirmed execution
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any
from urllib.parse import unquote

from fastapi import APIRouter, HTTPException
from langchain_core.language_models import BaseChatModel
from pydantic import BaseModel

from app.core.maintenance.agent import MaintenanceAgent
from app.core.prompts.manager import PromptManager

logger = logging.getLogger("llm-wiki")

router = APIRouter(prefix="/maintenance", tags=["maintenance"])


# ── Request / Response models ──────────────────────────────────────


class InvestigateRequest(BaseModel):
    """Request body for the investigate endpoint."""

    request: str


class PreviewRequest(BaseModel):
    """Request body for the preview endpoint."""

    plan: dict[str, Any]


class ExecuteRequest(BaseModel):
    """Request body for the execute endpoint."""

    plan: dict[str, Any]
    confirmed: bool = False


class MaintenanceResponse(BaseModel):
    """Response body for maintenance endpoints."""

    data: dict[str, Any]


# ── Agent helper ───────────────────────────────────────────────────

# In-memory registry of (llm, prompt_manager) for each project path.
# In production this would be looked up from a proper configuration store.
_project_config: dict[str, dict[str, Any]] = {}


def register_project_config(
    project_path: str,
    llm: BaseChatModel,
    prompt_manager: PromptManager,
    search_engine: Any | None = None,
    version_control: Any | None = None,
) -> None:
    """Register LLM and prompt manager for a project.

    This should be called during initialisation (e.g. when a project is
    opened in the UI).
    """
    _project_config[project_path] = {
        "llm": llm,
        "prompt_manager": prompt_manager,
        "search_engine": search_engine,
        "version_control": version_control,
    }


def _get_project_config(project_path: str) -> dict[str, Any]:
    """Get the registered config for a project, or raise 404."""
    if project_path not in _project_config:
        raise HTTPException(
            status_code=404,
            detail=f"No configuration registered for project: {project_path}",
        )
    return _project_config[project_path]


def _validate_project(project_path: str) -> Path:
    """Validate that *project_path* points to a valid directory.

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


def _create_agent(project_path: str) -> MaintenanceAgent:
    """Create a ``MaintenanceAgent`` for the given project.

    Uses the registered LLM and prompt manager for that project.
    """
    config = _get_project_config(project_path)
    return MaintenanceAgent(
        llm=config["llm"],
        project_path=project_path,
        prompt_manager=config["prompt_manager"],
        search_engine=config.get("search_engine"),
        version_control=config.get("version_control"),
    )


# ── Endpoints ──────────────────────────────────────────────────────


@router.post("/{project_path:path}/investigate")
async def maintenance_investigate(
    project_path: str,
    body: InvestigateRequest,
) -> MaintenanceResponse:
    """Phase 1 — read-only investigation.

    The agent analyses the project and returns a structured maintenance
    plan.
    """
    _validate_project(project_path)

    try:
        agent = _create_agent(project_path)
        plan = agent.investigate(body.request)
        return MaintenanceResponse(data=plan)
    except Exception as exc:
        logger.exception("Investigate error for %s", project_path)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/{project_path:path}/preview")
async def maintenance_preview(
    project_path: str,
    body: PreviewRequest,
) -> MaintenanceResponse:
    """Phase 2 — preview changes (dry-run).

    Simulates every action in the plan and returns the resulting diff.
    """
    _validate_project(project_path)

    try:
        agent = _create_agent(project_path)
        diff = agent.preview(body.plan)
        return MaintenanceResponse(data=diff)
    except Exception as exc:
        logger.exception("Preview error for %s", project_path)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/{project_path:path}/execute")
async def maintenance_execute(
    project_path: str,
    body: ExecuteRequest,
) -> MaintenanceResponse:
    """Phase 3 — execute the plan with automatic snapshot.

    Requires ``confirmed=True`` in the request body.
    """
    _validate_project(project_path)

    try:
        agent = _create_agent(project_path)
        result = agent.execute(body.plan, confirmed=body.confirmed)
        return MaintenanceResponse(data=result)
    except Exception as exc:
        logger.exception("Execute error for %s", project_path)
        raise HTTPException(status_code=500, detail=str(exc))
