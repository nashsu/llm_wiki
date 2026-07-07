"""LRU search-result cache for the wiki search engine.

Provides a simple bounded cache using :class:`collections.OrderedDict`
so that the most recently accessed entries are retained when the cache
reaches its maximum size.
"""

from __future__ import annotations

from collections import OrderedDict
from typing import Any


class SearchCache:
    """LRU (least-recently-used) cache for search results.

    Usage::

        cache = SearchCache(max_size=100)
        cache.set("python language", [...results...])

        results = cache.get("python language")  # → list or None
        cache.invalidate("wiki/entities/python.md")  # remove entries for a page
        cache.invalidate()  # clear entire cache

        stats = cache.get_stats()
    """

    def __init__(self, max_size: int = 100) -> None:
        """Initialize an empty LRU cache.

        Parameters
        ----------
        max_size:
            Maximum number of query entries to keep.  When the cache
            exceeds this size, the least recently accessed entry is
            evicted.
        """
        if max_size < 1:
            raise ValueError("max_size must be >= 1")

        self._max_size = max_size
        self._cache: OrderedDict[str, list[dict[str, Any]]] = OrderedDict()

        # Statistics
        self._hits: int = 0
        self._misses: int = 0

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def get(self, query: str) -> list[dict[str, Any]] | None:
        """Retrieve cached results for *query*.

        If the query is found it is moved to the end of the LRU order
        (most recently used position).

        Parameters
        ----------
        query:
            The search query string.

        Returns
        -------
        list[dict] | None:
            The cached results list, or ``None`` if the query is not
            present.
        """
        if query in self._cache:
            self._cache.move_to_end(query)
            self._hits += 1
            return self._cache[query]

        self._misses += 1
        return None

    def set(self, query: str, results: list[dict[str, Any]]) -> None:
        """Store search results for *query*.

        If the query already exists its entry is updated and moved to
        the most recently used position.  If the cache is at capacity,
        the least recently used entry is evicted first.

        Parameters
        ----------
        query:
            The search query string.
        results:
            The list of result dicts to cache.
        """
        if query in self._cache:
            self._cache.move_to_end(query)

        self._cache[query] = results

        while len(self._cache) > self._max_size:
            self._cache.popitem(last=False)  # evict LRU (first inserted)

    def invalidate(self, page_path: str | None = None) -> None:
        """Invalidate cached entries.

        Parameters
        ----------
        page_path:
            If provided, only entries whose result list contains a dict
            with a ``"path"``, ``"id"``, or ``"page"`` key matching
            *page_path* are removed.  If ``None``, the entire cache is
            cleared.
        """
        if page_path is None:
            self._cache.clear()
            return

        keys_to_remove: list[str] = []
        for query, results in self._cache.items():
            for result in results:
                result_path = result.get("path") or result.get("id") or result.get("page")
                if result_path == page_path:
                    keys_to_remove.append(query)
                    break

        for key in keys_to_remove:
            del self._cache[key]

    def get_stats(self) -> dict[str, Any]:
        """Return cache statistics.

        Returns
        -------
        dict:
            Keys include ``size``, ``max_size``, ``hits``, ``misses``,
            ``hit_rate`` (float in ``[0, 1]``, or ``0.0`` if no accesses).
        """
        total = self._hits + self._misses
        hit_rate = self._hits / total if total > 0 else 0.0
        return {
            "size": len(self._cache),
            "max_size": self._max_size,
            "hits": self._hits,
            "misses": self._misses,
            "hit_rate": hit_rate,
        }
