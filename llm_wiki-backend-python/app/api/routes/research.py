"""Research API routes — topic generation, web search, and deep research.

Endpoints
---------
- ``POST /api/research/{project_path:path}/topics`` — generate research topics
- ``POST /api/research/{project_path:path}/search`` — execute a web search
- ``POST /api/research/{project_path:path}/run`` — full deep research pipeline
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any
from urllib.parse import unquote

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.core.llm.factory import LLMFactory
from app.core.prompts import PromptManager
from app.core.research import DeepResearcher, SearchProvider, WebSearcher

logger = logging.getLogger("llm-wiki")

router = APIRouter(prefix="/research", tags=["research"])

# ── Request / Response models ──────────────────────────────────────────


class SearchRequest(BaseModel):
    """Body for the search endpoint."""

    query: str
    provider: str = "tavily"
    api_key: str = ""
    num_results: int = 5
    config: dict[str, Any] = {}
    llm_config: dict[str, Any] = {}


class RunRequest(BaseModel):
    """Body for the deep research run endpoint."""

    topic: str | None = None
    provider: str = "tavily"
    api_key: str = ""
    num_results: int = 5
    config: dict[str, Any] = {}
    llm_config: dict[str, Any] = {}
    purpose: str = ""
    overview: str = ""
    related_pages: str = ""
    language_directive: str = ""


class TopicsRequest(BaseModel):
    """Body for the topics generation endpoint."""

    purpose: str
    overview: str
    language_directive: str = "Respond in the same language as the Wiki."
    llm_config: dict[str, Any] = {}


# ── Helpers ────────────────────────────────────────────────────────────


def _validate_project(project_path: str) -> Path:
    """Validate that *project_path* points to a valid Wiki project."""
    decoded = unquote(project_path)
    root = Path(decoded).resolve()
    if not root.is_dir():
        raise HTTPException(
            status_code=404,
            detail=f"Project not found: {decoded}",
        )
    return root


def _build_searcher(provider: str, api_key: str, config: dict[str, Any]) -> WebSearcher:
    """Build a ``WebSearcher`` from request parameters."""
    try:
        search_provider = SearchProvider(provider.lower())
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported search provider: {provider}. "
            f"Choose from: {[p.value for p in SearchProvider]}",
        )
    return WebSearcher(provider=search_provider, api_key=api_key, **config)


def _build_llm(llm_config: dict[str, Any]) -> Any:
    """Build a LangChain LLM from a minimal config dict.

    The config must include at least ``protocol`` and ``api_key``.
    Optional keys: ``api_base``, ``model``.
    """
    from app.models.config import ModelProvider, ProviderProtocol
    from datetime import datetime, timezone

    protocol_str = llm_config.get("protocol", "openai")
    try:
        protocol = ProviderProtocol(protocol_str)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported LLM protocol: {protocol_str}",
        )

    provider = ModelProvider(
        id="research-llm",
        name="Research LLM",
        protocol=protocol,
        api_key=llm_config.get("api_key", ""),
        api_base=llm_config.get("api_base"),
        default_model=llm_config.get("model", "gpt-4o"),
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )
    return LLMFactory.create(provider)


# ── Endpoints ──────────────────────────────────────────────────────────


@router.post("/{project_path:path}/topics")
async def generate_topics(project_path: str, body: TopicsRequest):
    """Generate research topics based on the Wiki's purpose and overview.

    Uses the LLM to analyse gaps and return optimised research topics with
    search queries.
    """
    root = _validate_project(project_path)

    llm = _build_llm(body.llm_config)
    prompt_manager = PromptManager(root)
    searcher = _build_searcher("tavily", "", {})
    researcher = DeepResearcher(llm=llm, searcher=searcher, prompt_manager=prompt_manager)

    try:
        topics = researcher.generate_topics(
            {
                "purpose": body.purpose,
                "overview": body.overview,
                "language_directive": body.language_directive,
            }
        )
        return {"topics": topics}
    except Exception as exc:
        logger.exception("Topic generation failed for %s", project_path)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/{project_path:path}/search")
async def search(project_path: str, body: SearchRequest):
    """Execute a web search and return results."""
    _validate_project(project_path)

    searcher = _build_searcher(body.provider, body.api_key, body.config)

    try:
        results = searcher.search(query=body.query, num_results=body.num_results)
        return {"results": results, "total": len(results)}
    except Exception as exc:
        logger.exception("Search failed for %s", project_path)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/{project_path:path}/run")
async def run_deep_research(project_path: str, body: RunRequest):
    """Run the full deep research pipeline.

    Generates topics (or uses the provided ``topic``), executes web
    searches, synthesises results, and writes a research page to
    ``wiki/research/``.
    """
    root = _validate_project(project_path)

    llm = _build_llm(body.llm_config)
    searcher = _build_searcher(body.provider, body.api_key, body.config)
    prompt_manager = PromptManager(root)
    researcher = DeepResearcher(llm=llm, searcher=searcher, prompt_manager=prompt_manager)

    try:
        result = researcher.run(
            project_path=root,
            topic=body.topic,
            context={
                "purpose": body.purpose,
                "overview": body.overview,
                "related_pages": body.related_pages,
                "language_directive": body.language_directive,
            },
        )
        return result
    except Exception as exc:
        logger.exception("Deep research failed for %s", project_path)
        raise HTTPException(status_code=500, detail=str(exc))
