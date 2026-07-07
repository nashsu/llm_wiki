"""API routes for project CRUD operations."""

import logging
from urllib.parse import unquote

from fastapi import APIRouter, HTTPException

from app.services.project_service import ProjectService

logger = logging.getLogger("llm-wiki")

router = APIRouter(prefix="/projects", tags=["projects"])

_svc = ProjectService()


# ── Template Endpoints ────────────────────────────────────────────


@router.get("/templates")
async def list_project_templates():
    """List all available project templates."""
    return _svc.list_templates()


# ── Create ────────────────────────────────────────────────────────


@router.post("/create")
async def create_project(body: dict):
    """Create a new project from a template.

    Request body:
        ``name`` (str): Human-readable project name.
        ``template_id`` (str): Template identifier.
        ``path`` (str): Absolute filesystem path for the project.
    """
    name = body.get("name", "")
    template_id = body.get("template_id", "")
    path = body.get("path", "")

    if not name or not template_id or not path:
        raise HTTPException(
            status_code=422,
            detail="Missing required fields: name, template_id, path",
        )

    try:
        result = _svc.create_project(name, template_id, path)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    logger.info("Project created: %s at %s (template=%s)", name, path, template_id)
    return result


# ── Open ──────────────────────────────────────────────────────────


@router.post("/open")
async def open_project(body: dict):
    """Open a project and update recent/last-project records.

    Request body:
        ``path`` (str): Absolute path to the project directory.
    """
    path = body.get("path", "")
    if not path:
        raise HTTPException(status_code=422, detail="Missing required field: path")

    try:
        result = _svc.open_project(path)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    logger.info("Project opened: %s", path)
    return result


# ── Validate ──────────────────────────────────────────────────────


@router.post("/validate")
async def validate_project(body: dict):
    """Check whether a path is a valid LLM Wiki project.

    Request body:
        ``path`` (str): Absolute path to check.
    """
    path = body.get("path", "")
    if not path:
        raise HTTPException(status_code=422, detail="Missing required field: path")

    is_valid = _svc.validate_project(path)
    return {"path": path, "valid": is_valid}


# ── Delete ────────────────────────────────────────────────────────


@router.delete("/{project_path:path}")
async def delete_project(project_path: str):
    """Delete a project at the given path.

    The path should be URL-encoded in the request.
    """
    decoded = unquote(project_path)
    try:
        _svc.delete_project(decoded)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    logger.info("Project deleted: %s", decoded)
    return {"status": "ok", "path": decoded}


# ── Recent / Last ─────────────────────────────────────────────────


@router.get("/recent")
async def list_recent_projects():
    """Return the list of recently opened projects."""
    return _svc.get_recent_projects()


@router.get("/last")
async def get_last_project():
    """Return the last opened project, or 404 if none."""
    result = _svc.get_last_project()
    if result is None:
        raise HTTPException(status_code=404, detail="No last project found")
    return result
