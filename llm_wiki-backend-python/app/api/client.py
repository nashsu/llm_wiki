"""LLM Wiki API client — HTTP wrapper for the Python backend.

Usage::

    from app.api.client import LLMWikiClient

    client = LLMWikiClient()
    projects = await client.list_templates()
"""

from __future__ import annotations

import json
import logging
from typing import Any, AsyncGenerator
from urllib.parse import quote

import httpx

logger = logging.getLogger("llm-wiki")

DEFAULT_BASE_URL = "http://127.0.0.1:19828"


class ApiError(Exception):
    """Raised when the API returns a non-2xx response."""

    def __init__(self, status: int, detail: Any) -> None:
        self.status = status
        self.detail = detail
        super().__init__(f"API error {status}: {detail}")


class LLMWikiClient:
    """HTTP client for the LLM Wiki Python backend API.

    All methods are async and raise :class:`ApiError` on non-2xx responses.
    Path arguments with special characters (e.g. Windows backslashes) are
    automatically URL-encoded.
    """

    def __init__(self, base_url: str = DEFAULT_BASE_URL) -> None:
        self._base_url = base_url.rstrip("/")
        self._client = httpx.AsyncClient(timeout=60.0)

    async def close(self) -> None:
        """Close the underlying HTTP session."""
        await self._client.aclose()

    async def __aenter__(self) -> LLMWikiClient:
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _encode_path(path: str) -> str:
        """URL-encode a path segment (handles Windows backslashes)."""
        # Normalise backslashes first, then encode
        normalised = path.replace("\\", "/")
        return quote(normalised, safe="/")

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: Any = None,
        params: dict[str, str] | None = None,
    ) -> Any:
        """Send an HTTP request and return the parsed JSON response."""
        url = f"{self._base_url}{path}"
        try:
            response = await self._client.request(
                method, url, json=json_body, params=params
            )
        except httpx.RequestError as exc:
            logger.error("Request failed: %s %s — %s", method, url, exc)
            raise ApiError(0, str(exc)) from exc

        if not response.is_success:
            detail: Any = {}
            try:
                detail = response.json()
            except Exception:
                detail = response.text
            raise ApiError(response.status_code, detail)

        if response.status_code == 204:
            return None
        return response.json()

    async def _stream_sse(
        self, path: str, json_body: Any
    ) -> AsyncGenerator[dict[str, Any], None]:
        """Stream SSE events from a POST endpoint.

        Yields parsed JSON dicts from ``data:`` lines.
        """
        url = f"{self._base_url}{path}"
        async with self._client.stream(
            "POST", url, json=json_body, timeout=None
        ) as response:
            if not response.is_success:
                detail: Any = {}
                try:
                    detail = await response.aread()
                    detail = json.loads(detail)
                except Exception:
                    detail = await response.aread()
                raise ApiError(response.status_code, detail)

            async for line in response.aiter_lines():
                line = line.strip()
                if line.startswith("data: "):
                    payload = line.removeprefix("data: ").strip()
                    if payload:
                        yield json.loads(payload)

    # ------------------------------------------------------------------
    # Project Management
    # ------------------------------------------------------------------

    async def list_templates(self) -> Any:
        """GET /api/projects/templates — list available project templates."""
        return await self._request("GET", "/api/projects/templates")

    async def create_project(
        self, name: str, template_id: str, path: str
    ) -> Any:
        """POST /api/projects/create — create a new project from a template."""
        return await self._request(
            "POST",
            "/api/projects/create",
            json_body={"name": name, "template_id": template_id, "path": path},
        )

    async def open_project(self, path: str) -> Any:
        """POST /api/projects/open — open a project and update recent records."""
        return await self._request(
            "POST", "/api/projects/open", json_body={"path": path}
        )

    async def validate_project(self, path: str) -> Any:
        """POST /api/projects/validate — check if a path is a valid project."""
        return await self._request(
            "POST", "/api/projects/validate", json_body={"path": path}
        )

    async def delete_project(self, path: str) -> Any:
        """DELETE /api/projects/{path} — delete a project.

        The *path* is URL-encoded automatically.
        """
        encoded = self._encode_path(path)
        return await self._request("DELETE", f"/api/projects/{encoded}")

    async def get_recent_projects(self) -> Any:
        """GET /api/projects/recent — list recently opened projects."""
        return await self._request("GET", "/api/projects/recent")

    async def get_last_project(self) -> Any:
        """GET /api/projects/last — return the last opened project."""
        return await self._request("GET", "/api/projects/last")

    # ------------------------------------------------------------------
    # File Operations
    # ------------------------------------------------------------------

    async def read_file(self, path: str, encoding: str = "utf-8") -> Any:
        """POST /api/files/read — read a text file."""
        return await self._request(
            "POST",
            "/api/files/read",
            json_body={"path": path, "encoding": encoding},
        )

    async def write_file(self, path: str, content: str | bytes) -> Any:
        """POST /api/files/write — write content to a file."""
        return await self._request(
            "POST",
            "/api/files/write",
            json_body={"path": path, "content": content},
        )

    async def list_directory(self, path: str) -> Any:
        """POST /api/files/list — list contents of a directory."""
        return await self._request(
            "POST", "/api/files/list", json_body={"path": path}
        )

    async def delete_file(self, path: str) -> Any:
        """POST /api/files/delete — delete a file or directory."""
        return await self._request(
            "POST", "/api/files/delete", json_body={"path": path}
        )

    async def rename_file(self, old_path: str, new_path: str) -> Any:
        """POST /api/files/rename — rename / move a file or directory."""
        return await self._request(
            "POST",
            "/api/files/rename",
            json_body={"old_path": old_path, "new_path": new_path},
        )

    async def copy_file(self, src: str, dst: str) -> Any:
        """POST /api/files/copy — copy a file."""
        return await self._request(
            "POST",
            "/api/files/copy",
            json_body={"src": src, "dst": dst},
        )

    # ------------------------------------------------------------------
    # Configuration Management
    # ------------------------------------------------------------------

    async def get_preference(self, key: str) -> Any:
        """GET /api/config/global/preferences/{key} — get a global preference."""
        return await self._request(
            "GET", f"/api/config/global/preferences/{quote(key, safe='')}"
        )

    async def set_preference(self, key: str, value: Any) -> Any:
        """PUT /api/config/global/preferences/{key} — set a global preference."""
        return await self._request(
            "PUT",
            f"/api/config/global/preferences/{quote(key, safe='')}",
            json_body={"value": value},
        )

    async def get_project_config(self, project_path: str) -> Any:
        """GET /api/config/project/{path}/config — get project configuration."""
        encoded = self._encode_path(project_path)
        return await self._request(
            "GET", f"/api/config/project/{encoded}/config"
        )

    async def update_project_config(
        self, project_path: str, config: dict[str, Any]
    ) -> Any:
        """PUT /api/config/project/{path}/config — update project configuration."""
        encoded = self._encode_path(project_path)
        return await self._request(
            "PUT",
            f"/api/config/project/{encoded}/config",
            json_body=config,
        )

    # ------------------------------------------------------------------
    # Provider Management
    # ------------------------------------------------------------------

    async def list_providers(self, project_path: str) -> Any:
        """GET /api/providers — list providers with masked API keys."""
        return await self._request(
            "GET",
            "/api/providers",
            params={"project_path": project_path},
        )

    async def create_provider(
        self, project_path: str, data: dict[str, Any]
    ) -> Any:
        """POST /api/providers — create a new LLM provider."""
        return await self._request(
            "POST",
            "/api/providers",
            params={"project_path": project_path},
            json_body=data,
        )

    async def test_connection(
        self, project_path: str, provider_id: str
    ) -> Any:
        """POST /api/providers/{id}/test — test a provider's connectivity."""
        return await self._request(
            "POST",
            f"/api/providers/{quote(provider_id, safe='')}/test",
            params={"project_path": project_path},
        )

    # ------------------------------------------------------------------
    # Ingest
    # ------------------------------------------------------------------

    async def enqueue_ingest(
        self, project_path: str, source_path: str
    ) -> Any:
        """POST /api/ingest/{path}/enqueue — enqueue a source for ingestion."""
        encoded = self._encode_path(project_path)
        return await self._request(
            "POST",
            f"/api/ingest/{encoded}/enqueue",
            json_body={"source_path": source_path},
        )

    async def get_queue_status(self, project_path: str) -> Any:
        """GET /api/ingest/{path}/queue — get the ingest queue status."""
        encoded = self._encode_path(project_path)
        return await self._request(
            "GET", f"/api/ingest/{encoded}/queue"
        )

    # ------------------------------------------------------------------
    # Chat
    # ------------------------------------------------------------------

    async def send_message(
        self,
        project_path: str,
        message: str,
        history: list[dict[str, str]] | None = None,
    ) -> Any:
        """POST /api/chat/{path}/send — synchronous chat."""
        encoded = self._encode_path(project_path)
        return await self._request(
            "POST",
            f"/api/chat/{encoded}/send",
            json_body={"message": message, "history": history},
        )

    async def stream_message(
        self,
        project_path: str,
        message: str,
        history: list[dict[str, str]] | None = None,
    ) -> AsyncGenerator[dict[str, Any], None]:
        """POST /api/chat/{path}/stream — SSE streaming chat.

        Yields parsed SSE events as dicts with ``type`` and optional
        ``content`` / ``name`` fields.
        """
        encoded = self._encode_path(project_path)
        async for event in self._stream_sse(
            f"/api/chat/{encoded}/stream",
            json_body={"message": message, "history": history},
        ):
            yield event

    # ------------------------------------------------------------------
    # Sidecar
    # ------------------------------------------------------------------

    async def health_check(self) -> Any:
        """GET /api/sidecar/health — lightweight health check."""
        return await self._request("GET", "/api/sidecar/health")

    async def get_sidecar_info(self) -> Any:
        """GET /api/sidecar/info — detailed sidecar metadata."""
        return await self._request("GET", "/api/sidecar/info")
