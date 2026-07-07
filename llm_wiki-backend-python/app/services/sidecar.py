"""Sidecar process management for Tauri integration.

The ``SidecarManager`` provides the Python-side lifecycle management for the
Tauri v2 sidecar mechanism: port discovery, self-info introspection, and
out-of-band health checks.
"""

import os
import socket
import time
from datetime import datetime, timezone

import httpx


class SidecarManager:
    """Manages the local sidecar process lifecycle information.

    This class is used both by the API routes (to report process status) and
    by the Tauri shell integration (to locate a free port before spawning
    uvicorn).
    """

    def __init__(self, port: int = 19828) -> None:
        self._port = port
        self._started_at: float = time.time()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    @property
    def port(self) -> int:
        """The port this manager instance is configured for."""
        return self._port

    @property
    def started_at(self) -> float:
        """Unix timestamp of when this manager was instantiated."""
        return self._started_at

    @staticmethod
    def find_free_port(start_port: int = 19828) -> int:
        """Return the first available port at or after *start_port*.

        Uses a standard socket bind test.  No ``psutil`` or other external
        dependency required.
        """
        port = start_port
        while True:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
                try:
                    sock.bind(("127.0.0.1", port))
                    return port
                except OSError:
                    port += 1

    def get_sidecar_info(self) -> dict:
        """Return a snapshot of the current process information.

        Returns:
            A dict with keys: ``pid``, ``port``, ``status``, ``started_at``.
        """
        return {
            "pid": os.getpid(),
            "port": self._port,
            "status": "running",
            "started_at": datetime.fromtimestamp(
                self._started_at, tz=timezone.utc
            ).isoformat(),
        }

    def health_check(self, port: int | None = None) -> bool:
        """Perform an out-of-band HTTP health check against ``/health``.

        Args:
            port: Target port (defaults to the instance's own ``port``).

        Returns:
            ``True`` when the service responds with HTTP 200.
        """
        target_port = port or self._port
        try:
            resp = httpx.get(
                f"http://127.0.0.1:{target_port}/health",
                timeout=2.0,
            )
            return resp.status_code == 200
        except httpx.HTTPError:
            return False
