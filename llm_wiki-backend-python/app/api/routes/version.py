"""Version control API routes.

Provides HTTP endpoints for snapshot, branch, and rollback operations
backed by the ``VersionControl`` service.
"""

from __future__ import annotations

import logging
from pathlib import Path
from urllib.parse import unquote

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services.version_control import (
    GitCommandError,
    RepoNotFound,
    VersionControl,
    VersionControlError,
)

logger = logging.getLogger("llm-wiki")

router = APIRouter(prefix="/version", tags=["version"])

# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------


class SnapshotRequest(BaseModel):
    name: str = ""
    scope: str = "wiki"


class SnapshotResponse(BaseModel):
    results: dict


class RollbackRequest(BaseModel):
    snapshot_id: str
    scope: str = "wiki"
    create_branch: bool = True


class BranchRequest(BaseModel):
    name: str


class CheckoutRequest(BaseModel):
    name: str


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------


def _get_vc(project_path: str) -> VersionControl:
    """Resolve a URL-encoded project path and return a VersionControl instance.

    The project path must point to a valid existing directory.
    """
    decoded = unquote(project_path)
    p = Path(decoded).resolve()
    if not p.is_dir():
        raise HTTPException(
            status_code=404,
            detail=f"Project directory not found: {decoded}",
        )
    return VersionControl(p)


def _handle_vc_error(exc: VersionControlError) -> HTTPException:
    """Convert a VersionControl exception into an HTTP exception."""
    if isinstance(exc, RepoNotFound):
        return HTTPException(status_code=404, detail=str(exc))
    if isinstance(exc, GitCommandError):
        return HTTPException(status_code=400, detail=str(exc))
    return HTTPException(status_code=400, detail=str(exc))


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post("/{project_path:path}/snapshot")
async def create_snapshot(project_path: str, body: SnapshotRequest) -> dict:
    """Create a snapshot (commit) in the repository.

    Request body:
        ``name`` (str): Snapshot label (auto-prefixed).
        ``scope`` (str): ``"wiki"``, ``"raw"``, or ``"both"``.
    """
    try:
        vc = _get_vc(project_path)
        results = vc.create_snapshot(name=body.name, scope=body.scope)
    except VersionControlError as exc:
        raise _handle_vc_error(exc) from exc

    logger.info("Snapshot created (scope=%s): %s", body.scope, results)
    return {"results": results, "project_path": unquote(project_path)}


@router.get("/{project_path:path}/snapshots")
async def list_snapshots(
    project_path: str, scope: str = "wiki"
) -> dict:
    """List all snapshots (commits) in the repository.

    Query params:
        ``scope`` (str): ``"wiki"``, ``"raw"``, or ``"both"``.
    """
    try:
        vc = _get_vc(project_path)
        results = vc.list_snapshots(scope=scope)
    except VersionControlError as exc:
        raise _handle_vc_error(exc) from exc

    return {"results": results, "project_path": unquote(project_path), "scope": scope}


@router.get("/{project_path:path}/snapshot/{snapshot_id}/diff")
async def get_snapshot_diff(
    project_path: str, snapshot_id: str, scope: str = "wiki"
) -> dict:
    """Show diff summary between a snapshot and HEAD.

    Path params:
        ``snapshot_id`` (str): Commit hash or reference.

    Query params:
        ``scope`` (str): ``"wiki"``, ``"raw"``, or ``"both"``.
    """
    try:
        vc = _get_vc(project_path)
        results = vc.get_snapshot_diff(snapshot_id=snapshot_id, scope=scope)
    except VersionControlError as exc:
        raise _handle_vc_error(exc) from exc

    return {
        "results": results,
        "project_path": unquote(project_path),
        "snapshot_id": snapshot_id,
        "scope": scope,
    }


@router.post("/{project_path:path}/rollback")
async def rollback(project_path: str, body: RollbackRequest) -> dict:
    """Roll back the repository to a previous snapshot.

    Request body:
        ``snapshot_id`` (str): Target commit hash or reference.
        ``scope`` (str): ``"wiki"``, ``"raw"``, or ``"both"``.
        ``create_branch`` (bool): Create a rollback branch first.
    """
    try:
        vc = _get_vc(project_path)
        results = vc.rollback(
            snapshot_id=body.snapshot_id,
            scope=body.scope,
            create_branch=body.create_branch,
        )
    except VersionControlError as exc:
        raise _handle_vc_error(exc) from exc

    logger.info(
        "Rollback (scope=%s) to %s, branch=%s",
        body.scope,
        body.snapshot_id,
        body.create_branch,
    )
    return {
        "results": results,
        "project_path": unquote(project_path),
    }


@router.get("/{project_path:path}/branches")
async def list_branches(project_path: str, scope: str = "wiki") -> dict:
    """List all branches in the repository.

    Query params:
        ``scope`` (str): ``"wiki"``, ``"raw"``, or ``"both"``.
    """
    try:
        vc = _get_vc(project_path)
        results = vc.list_branches(scope=scope)
    except VersionControlError as exc:
        raise _handle_vc_error(exc) from exc

    return {
        "results": results,
        "project_path": unquote(project_path),
        "scope": scope,
    }


@router.post("/{project_path:path}/branch")
async def create_branch(project_path: str, body: BranchRequest) -> dict:
    """Create a new branch.

    Request body:
        ``name`` (str): Branch name.
        ``scope`` (str): ``"wiki"``, ``"raw"``, or ``"both"`` (default: "wiki").
    """
    scope = getattr(body, "scope", "wiki")
    try:
        vc = _get_vc(project_path)
        results = vc.create_branch(name=body.name, scope=scope)
    except VersionControlError as exc:
        raise _handle_vc_error(exc) from exc

    logger.info("Branch created (scope=%s): %s", scope, body.name)
    return {"results": results, "project_path": unquote(project_path), "name": body.name}


@router.post("/{project_path:path}/checkout")
async def switch_branch(project_path: str, body: CheckoutRequest) -> dict:
    """Switch to an existing branch.

    Request body:
        ``name`` (str): Branch name.
        ``scope`` (str): ``"wiki"``, ``"raw"``, or ``"both"`` (default: "wiki").
    """
    scope = getattr(body, "scope", "wiki")
    try:
        vc = _get_vc(project_path)
        results = vc.switch_branch(name=body.name, scope=scope)
    except VersionControlError as exc:
        raise _handle_vc_error(exc) from exc

    return {
        "results": results,
        "project_path": unquote(project_path),
        "name": body.name,
    }


@router.get("/{project_path:path}/status")
async def get_status(project_path: str, scope: str = "wiki") -> dict:
    """Get the current working tree status.

    Query params:
        ``scope`` (str): ``"wiki"``, ``"raw"``, or ``"both"``.
    """
    try:
        vc = _get_vc(project_path)
        results = vc.get_status(scope=scope)
    except VersionControlError as exc:
        raise _handle_vc_error(exc) from exc

    return {
        "results": results,
        "project_path": unquote(project_path),
        "scope": scope,
    }
