"""Chunk-level vector store API routes.

These endpoints mirror the Tauri ``invoke`` commands that the frontend's
``embedding.ts`` currently calls, providing an HTTP alternative for the
Python backend.

All routes are under ``/api/vector/{project_path}`` where
``project_path`` is a filesystem path to the wiki project root.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services.chunk_vector_store import ChunkVectorStore

router = APIRouter(prefix="/vector", tags=["vector"])

# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------


class UpsertChunksRequest(BaseModel):
    page_id: str
    chunks: list[dict]


class SearchChunksRequest(BaseModel):
    query_embedding: list[float]
    top_k: int = 30


class ChunkSearchResult(BaseModel):
    chunk_id: str
    page_id: str
    chunk_index: int
    chunk_text: str
    heading_path: str
    score: float


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _get_store(project_path: str) -> ChunkVectorStore:
    """Return a ChunkVectorStore for the given project path."""
    return ChunkVectorStore(project_path)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post("/{project_path:path}/upsert-chunks")
async def upsert_chunks(project_path: str, req: UpsertChunksRequest) -> dict:
    """Replace all chunks for a page, then insert new ones."""
    try:
        store = _get_store(project_path)
        store.upsert_chunks(req.page_id, req.chunks)
        return {"status": "ok"}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/{project_path:path}/search-chunks", response_model=list[ChunkSearchResult])
async def search_chunks(project_path: str, req: SearchChunksRequest) -> list[dict]:
    """Search for chunks similar to the query embedding."""
    try:
        store = _get_store(project_path)
        raw = store.search_chunks(req.query_embedding, req.top_k)
        results = []
        for row in raw:
            distance = row.pop("_distance", 0.0)
            # Convert distance to a similarity score (higher = better)
            score = 1.0 / (1.0 + distance)
            row["score"] = round(score, 6)
            results.append(row)
        return results
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.delete("/{project_path:path}/page/{page_id}")
async def delete_page(project_path: str, page_id: str) -> dict:
    """Delete all chunks for a specific page."""
    try:
        store = _get_store(project_path)
        store.delete_page(page_id)
        return {"status": "ok"}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/{project_path:path}/count")
async def count_chunks(project_path: str) -> int:
    """Return the total number of chunk rows."""
    try:
        store = _get_store(project_path)
        return store.count()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.delete("/{project_path:path}/clear")
async def clear_chunks(project_path: str) -> dict:
    """Drop all chunk data."""
    try:
        store = _get_store(project_path)
        store.clear()
        return {"status": "ok"}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.post("/{project_path:path}/optimize")
async def optimize_chunks(project_path: str) -> dict:
    """Compact the chunk vector table."""
    try:
        store = _get_store(project_path)
        store.optimize()
        return {"status": "ok"}
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@router.get("/{project_path:path}/legacy-count")
async def legacy_row_count(project_path: str) -> int:
    """Return the legacy per-page table row count (always 0 — migrated)."""
    return 0


@router.delete("/{project_path:path}/legacy-drop")
async def drop_legacy(project_path: str) -> dict:
    """Drop the legacy per-page vector table (no-op — already migrated)."""
    return {"status": "ok"}
