"""Sidecar lifecycle API routes.

These endpoints allow the Tauri frontend to query the sidecar process status
and request a graceful shutdown.
"""

import asyncio
import logging
import os
import signal
import time

from fastapi import APIRouter, HTTPException, Request

from app.config import settings
from app.services.sidecar import SidecarManager

logger = logging.getLogger("llm-wiki")

router = APIRouter(prefix="/sidecar", tags=["sidecar"])

# Module-level manager singleton -- follows the same pattern as
# ``app/api/routes/files.py``.
_manager = SidecarManager(port=settings.port)

_LOCALHOST_IPS = frozenset({"127.0.0.1", "::1", "localhost"})


def _assert_localhost(request: Request) -> None:
    """Raise 403 if the request did not originate from the local machine."""
    client_host = request.client.host if request.client else "unknown"
    if client_host not in _LOCALHOST_IPS:
        raise HTTPException(
            status_code=403,
            detail="This endpoint is only accessible from localhost",
        )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/health")
async def health() -> dict:
    """Lightweight health check for the sidecar process.

    Returns the current process PID, the configured port, and uptime.
    """
    return {
        "status": "running",
        "pid": os.getpid(),
        "port": _manager.port,
        "uptime": round(time.time() - _manager.started_at, 2),
    }


@router.get("/info")
async def info() -> dict:
    """Return detailed sidecar metadata (process + version info)."""
    info_data = _manager.get_sidecar_info()
    info_data["version"] = settings.app_version
    info_data["app_name"] = settings.app_name
    info_data["python_version"] = (
        f"{__import__('sys').version_info.major}."
        f"{__import__('sys').version_info.minor}."
        f"{__import__('sys').version_info.micro}"
    )
    return info_data


@router.post("/shutdown")
async def shutdown(request: Request) -> dict:
    """Gracefully shut down the sidecar process.

    This endpoint is restricted to requests originating from **localhost**
    only.  A short delay is introduced so the HTTP response is sent before
    the process exits.
    """
    _assert_localhost(request)

    logger.info("Shutdown requested via /api/sidecar/shutdown")

    async def _delayed_shutdown() -> None:
        await asyncio.sleep(0.2)
        os.kill(os.getpid(), signal.SIGTERM)

    asyncio.create_task(_delayed_shutdown())

    return {"status": "shutting_down"}
