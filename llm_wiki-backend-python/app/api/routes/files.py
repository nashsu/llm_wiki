"""File operation API routes."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services.file_service import (
    FileAlreadyExists,
    FileNotFound,
    FileService,
    FileServiceError,
    PathTraversalError,
)

router = APIRouter(prefix="/files", tags=["files"])

# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------


class ReadRequest(BaseModel):
    path: str
    encoding: str = "utf-8"


class WriteRequest(BaseModel):
    path: str
    content: str | bytes


class ListRequest(BaseModel):
    path: str


class DeleteRequest(BaseModel):
    path: str


class RenameRequest(BaseModel):
    old_path: str
    new_path: str


class CopyRequest(BaseModel):
    src: str
    dst: str


class InfoRequest(BaseModel):
    path: str


class InfoResponse(BaseModel):
    name: str
    path: str
    size: int
    modified: float
    is_dir: bool
    mime_type: str


class ExistsRequest(BaseModel):
    path: str


class ExistsResponse(BaseModel):
    exists: bool


# ---------------------------------------------------------------------------
# Service initialisation
# ---------------------------------------------------------------------------

# No fixed work directory – accepts arbitrary absolute paths from the
# front-end (which sends ``D:/project/data/xxx.md``-style paths).
_file_service = FileService()  # work_dir=None → accepts absolute paths only


def _handle_service_error(exc: FileServiceError) -> HTTPException:
    """Convert a FileService exception into a user-safe HTTP exception."""
    if isinstance(exc, PathTraversalError):
        status = 403
    elif isinstance(exc, FileNotFound):
        status = 404
    elif isinstance(exc, FileAlreadyExists):
        status = 409
    else:
        status = 400
    return HTTPException(status_code=status, detail=str(exc))


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post("/read")
async def read(req: ReadRequest) -> dict:
    """Read a text file and return the content."""
    try:
        content = _file_service.read_file(req.path, encoding=req.encoding)
    except FileServiceError as exc:
        raise _handle_service_error(exc) from exc
    return {"content": content}


@router.post("/write")
async def write(req: WriteRequest) -> dict:
    """Write content to a file (creates parent directories)."""
    try:
        _file_service.write_file(req.path, req.content)
    except FileServiceError as exc:
        raise _handle_service_error(exc) from exc
    return {"success": True}


@router.post("/list")
async def list_dir(req: ListRequest) -> list[dict]:
    """List contents of a directory."""
    try:
        entries = _file_service.list_directory(req.path)
    except FileServiceError as exc:
        raise _handle_service_error(exc) from exc
    return entries


@router.post("/delete")
async def delete(req: DeleteRequest) -> dict:
    """Delete a file or directory (recursive)."""
    try:
        _file_service.delete(req.path)
    except FileServiceError as exc:
        raise _handle_service_error(exc) from exc
    return {"success": True}


@router.post("/rename")
async def rename(req: RenameRequest) -> dict:
    """Rename / move a file or directory."""
    try:
        _file_service.rename_file(req.old_path, req.new_path)
    except FileServiceError as exc:
        raise _handle_service_error(exc) from exc
    return {"success": True}


@router.post("/copy")
async def copy(req: CopyRequest) -> dict:
    """Copy a file."""
    try:
        _file_service.copy_file(req.src, req.dst)
    except FileServiceError as exc:
        raise _handle_service_error(exc) from exc
    return {"success": True}


@router.post("/info", response_model=InfoResponse)
async def info(req: InfoRequest) -> InfoResponse:
    """Get file/directory metadata."""
    try:
        meta = _file_service.get_file_info(req.path)
    except FileServiceError as exc:
        raise _handle_service_error(exc) from exc
    return InfoResponse(**meta)


@router.post("/exists", response_model=ExistsResponse)
async def exists(req: ExistsRequest) -> ExistsResponse:
    """Check if a path exists."""
    try:
        found = _file_service.file_exists(req.path)
    except FileServiceError as exc:
        raise _handle_service_error(exc) from exc
    return ExistsResponse(exists=found)
