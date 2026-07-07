"""API routes for global and per-project configuration."""

import json
from urllib.parse import unquote

from fastapi import APIRouter, HTTPException

from app.models.config import ProjectConfig
from app.services.config_service import (
    GlobalConfigService,
    ProjectConfigService,
    mask_project_config,
)

router = APIRouter(prefix="/config", tags=["config"])

_global_svc = GlobalConfigService()
_project_svc = ProjectConfigService()


# ── Global Preferences ───────────────────────────────────────────


@router.get("/global/preferences/{key}")
async def get_preference(key: str):
    """Get a global preference value by key."""
    raw = _global_svc.get_preference(key)
    if raw is None:
        return {"key": key, "value": None}
    try:
        value = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        value = raw
    return {"key": key, "value": value}


@router.put("/global/preferences/{key}")
async def set_preference(key: str, body: dict):
    """Set a global preference value."""
    value = body.get("value")
    raw = json.dumps(value, ensure_ascii=False) if value is not None else json.dumps(None)
    _global_svc.set_preference(key, raw)
    return {"key": key, "value": value}


# ── Recent Projects ──────────────────────────────────────────────


@router.get("/global/recent-projects")
async def list_recent_projects():
    """List recent projects ordered by last opened time."""
    return _global_svc.get_recent_projects()


@router.delete("/global/recent-projects/{path:path}")
async def delete_recent_project(path: str):
    """Remove a project from the recent projects list."""
    decoded = unquote(path)
    _global_svc.remove_recent_project(decoded)
    return {"status": "ok"}


# ── Last Project ─────────────────────────────────────────────────


@router.get("/global/last-project")
async def get_last_project():
    """Get the last opened project."""
    result = _global_svc.get_last_project()
    if result is None:
        raise HTTPException(status_code=404, detail="No last project found")
    return result


@router.put("/global/last-project")
async def set_last_project(body: dict):
    """Set the last opened project."""
    path = body.get("path", "")
    name = body.get("name", "")
    _global_svc.set_last_project(path, name)
    return {"status": "ok"}


# ── Project Config ────────────────────────────────────────────────


@router.get("/project/{project_path:path}/config")
async def get_project_config(project_path: str):
    """Get the project configuration with masked secrets."""
    decoded = unquote(project_path)
    config = _project_svc.load(decoded)
    masked = mask_project_config(config)
    return masked.model_dump(by_alias=True, mode="json", exclude_none=True)


@router.put("/project/{project_path:path}/config")
async def update_project_config(project_path: str, body: dict):
    """Update the full project configuration."""
    decoded = unquote(project_path)
    config = ProjectConfig.model_validate(body)
    _project_svc.save(decoded, config)
    masked = mask_project_config(config)
    return masked.model_dump(by_alias=True, mode="json", exclude_none=True)
