"""Web search providers and searcher abstraction.

Supports three backends:
- **Tavily** via the official Python SDK
- **SerpApi** via HTTP API (httpx)
- **SearXNG** via HTTP API (httpx)
"""

from __future__ import annotations

import logging
from enum import Enum
from typing import Any

import httpx

logger = logging.getLogger("llm-wiki")


class SearchProvider(str, Enum):
    """Supported web search backends."""

    TAVILY = "tavily"
    SERPAPI = "serpapi"
    SEARXNG = "searxng"


_RESULT_KEYS = {"title", "url", "content", "score"}


def _normalise_result(item: dict[str, Any], score: float = 1.0) -> dict[str, Any]:
    """Normalise a search result dict to ``{title, url, content, score}``.

    Args:
        item: Raw result dict from any search provider.
        score: Default relevance score if the provider does not supply one.

    Returns:
        A normalised result dict.
    """
    return {
        "title": item.get("title", ""),
        "url": item.get("url", item.get("link", "")),
        "content": item.get("content", item.get("snippet", item.get("raw_content", ""))),
        "score": float(item.get("score", item.get("relevance", score))),
    }


def _deduplicate(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Remove duplicates based on ``url``, preserving order and highest score.

    Args:
        results: List of normalised result dicts.

    Returns:
        Deduplicated list.
    """
    seen: set[str] = set()
    unique: list[dict[str, Any]] = []
    for r in results:
        url = r.get("url", "")
        if url and url not in seen:
            seen.add(url)
            unique.append(r)
        elif not url:
            unique.append(r)
    return unique


class WebSearcher:
    """Unified web search interface across multiple providers.

    Args:
        provider: The search backend to use.
        api_key: API key for the provider (not needed for SearXNG).
        **kwargs: Provider-specific configuration (e.g. ``instance_url`` for
            SearXNG, ``engine`` for SerpApi).
    """

    def __init__(self, provider: SearchProvider, api_key: str = "", **kwargs: Any) -> None:
        self._provider = provider
        self._api_key = api_key
        self._kwargs = kwargs

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def search(self, query: str, num_results: int = 5) -> list[dict[str, Any]]:
        """Execute a single search query.

        Args:
            query: The search query string.
            num_results: Maximum number of results to return.

        Returns:
            A list of normalised result dicts, each with keys
            ``title``, ``url``, ``content``, ``score``.

        Raises:
            ValueError: If the provider is unsupported.
            httpx.HTTPError: On HTTP-level failures.
        """
        match self._provider:
            case SearchProvider.TAVILY:
                return self._search_tavily(query, num_results)
            case SearchProvider.SERPAPI:
                return self._search_serpapi(query, num_results)
            case SearchProvider.SEARXNG:
                return self._search_searxng(query, num_results)
            case _:
                raise ValueError(f"Unsupported search provider: {self._provider}")

    def search_multi(self, queries: list[str]) -> list[dict[str, Any]]:
        """Execute multiple search queries and return deduplicated results.

        Each query is run sequentially to avoid rate-limits.  Results are
        merged and deduplicated by URL, with scores preserved from the
        highest-ranked occurrence.

        Args:
            queries: List of search query strings.

        Returns:
            Deduplicated combined results across all queries.
        """
        all_results: list[dict[str, Any]] = []
        for query in queries:
            try:
                results = self.search(query)
                all_results.extend(results)
            except Exception:
                logger.exception("Search query failed: %s", query)
        return _deduplicate(all_results)

    # ------------------------------------------------------------------
    # Provider implementations
    # ------------------------------------------------------------------

    def _search_tavily(self, query: str, num_results: int) -> list[dict[str, Any]]:
        """Search via the Tavily Python SDK."""
        from tavily import TavilyClient

        client = TavilyClient(api_key=self._api_key)
        response = client.search(
            query=query,
            max_results=num_results,
            include_raw_content=True,
        )
        raw_results = response.get("results", [])
        return [_normalise_result(r, score=r.get("score", 1.0)) for r in raw_results]

    def _search_serpapi(self, query: str, num_results: int) -> list[dict[str, Any]]:
        """Search via SerpApi HTTP API."""
        params: dict[str, Any] = {
            "q": query,
            "api_key": self._api_key,
            "num": num_results,
            "engine": self._kwargs.get("engine", "google"),
            "output": "json",
        }
        response = httpx.get("https://serpapi.com/search", params=params, timeout=30)
        response.raise_for_status()
        data = response.json()

        raw_results: list[dict[str, Any]] = []
        for item in data.get("organic_results", []):
            raw_results.append(
                {
                    "title": item.get("title", ""),
                    "url": item.get("link", ""),
                    "content": item.get("snippet", ""),
                    "score": 1.0 / (item.get("position", 10) or 10),
                }
            )
        return _deduplicate(raw_results)

    def _search_searxng(self, query: str, num_results: int) -> list[dict[str, Any]]:
        """Search via a SearXNG instance (HTTP JSON API)."""
        instance_url = self._kwargs.get("instance_url", "http://localhost:8888")
        params: dict[str, Any] = {
            "q": query,
            "format": "json",
            "language": self._kwargs.get("language", "en"),
            "categories": self._kwargs.get("categories", "general"),
            "pageno": 1,
        }
        response = httpx.get(
            f"{instance_url.rstrip('/')}/search",
            params=params,
            timeout=30,
        )
        response.raise_for_status()
        data = response.json()

        raw_results: list[dict[str, Any]] = []
        for item in data.get("results", []):
            raw_results.append(
                {
                    "title": item.get("title", ""),
                    "url": item.get("url", ""),
                    "content": item.get("content", ""),
                    "score": item.get("score", 1.0),
                }
            )

        # Limit to requested number, sorted by score descending
        raw_results.sort(key=lambda r: r["score"], reverse=True)
        return raw_results[:num_results]
