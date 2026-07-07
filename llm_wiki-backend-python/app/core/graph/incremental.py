"""Incremental graph builder — supports single-page updates without full rebuild."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import networkx as nx

from app.core.graph.builder import WikiGraphBuilder
from app.core.graph.relevance import RelevanceModel

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_CACHE_DIR = ".llm-wiki"
_CACHE_FILE = "graph_cache.json"
_CACHE_VERSION = 1


# ---------------------------------------------------------------------------
# Serialisation helpers
# ---------------------------------------------------------------------------


def _graph_to_json(graph: nx.Graph) -> dict[str, Any]:
    """Serialize a NetworkX graph (nodes + weighted edges) to a JSON-safe dict.

    Parameters
    ----------
    graph:
        The graph to serialise.  Every node is expected to have at least
        a ``page_path`` attribute used as the node identifier.

    Returns
    -------
    dict:
        A dict with keys ``version``, ``nodes``, ``edges``.
    """
    nodes: dict[str, dict[str, Any]] = {}
    for node_id, data in graph.nodes(data=True):
        attrs = {
            "page_path": data.get("page_path", node_id),
            "type": data.get("type", "unknown"),
            "title": data.get("title", node_id),
            "sources": data.get("sources", []),
            "tags": data.get("tags", []),
        }
        nodes[node_id] = attrs

    edges: list[dict[str, Any]] = []
    for u, v, data in graph.edges(data=True):
        edge: dict[str, Any] = {"source": u, "target": v}
        if "weight" in data:
            edge["weight"] = data["weight"]
        if "type" in data:
            edge["type"] = data["type"]
        edges.append(edge)

    return {
        "version": _CACHE_VERSION,
        "nodes": nodes,
        "edges": edges,
    }


def _json_to_graph(data: dict[str, Any]) -> nx.Graph:
    """Reconstruct a NetworkX graph from a JSON dict produced by ``_graph_to_json``.

    Parameters
    ----------
    data:
        The deserialized JSON dict.

    Returns
    -------
    nx.Graph:
        The reconstructed graph.
    """
    graph = nx.Graph()

    for node_id, attrs in data.get("nodes", {}).items():
        graph.add_node(node_id, **attrs)

    for edge in data.get("edges", []):
        u = edge["source"]
        v = edge["target"]
        edge_attrs: dict[str, Any] = {}
        if "weight" in edge:
            edge_attrs["weight"] = edge["weight"]
        if "type" in edge:
            edge_attrs["type"] = edge["type"]
        graph.add_edge(u, v, **edge_attrs)

    return graph


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


class IncrementalGraphBuilder:
    """Incremental wiki graph builder with disk caching.

    Wraps :class:`WikiGraphBuilder` for the initial full build and then
    supports single-page updates (add, modify, delete) without having to
    re-scan the entire wiki directory each time.

    The graph is cached to ``.llm-wiki/graph_cache.json`` in the project
    root so that it persists across restarts.

    Usage::

        builder = IncrementalGraphBuilder(project_path)
        graph = builder.build_full()          # first-time full build
        graph = builder.update_page("entities/entity_a.md")  # incremental
        graph = builder.remove_page("entities/concept_d.md")
    """

    def __init__(self, project_path: Path) -> None:
        """Initialize the incremental builder.

        Parameters
        ----------
        project_path:
            Path to the project root (parent of the ``wiki/`` directory).
        """
        self._project_path = Path(project_path)
        self._wiki_path = self._project_path / "wiki"
        self._cache_dir = self._project_path / _CACHE_DIR
        self._cache_path = self._cache_dir / _CACHE_FILE
        self._model = RelevanceModel()

        # In-memory graph (always the latest state)
        self._graph: nx.Graph | None = None
        self._last_build_time: float = 0.0

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def build_full(self) -> nx.Graph:
        """Perform a full graph build and cache the result.

        Returns
        -------
        nx.Graph:
            A weighted graph with all wiki pages as nodes.
        """
        builder = WikiGraphBuilder(self._wiki_path)
        raw_graph = builder.build()
        self._graph = self._model.compute_all_weights(raw_graph)
        self._last_build_time = time.time()
        self._save_cache()
        return self._graph

    def update_page(self, page_path: str) -> nx.Graph:
        """Incrementally update the graph after adding or modifying a page.

        The old node (if it exists) and all its edges are removed first.
        The page is then re-read from disk, its metadata and wikilinks
        extracted, and the node + edges re-added.  Backlinks from other
        pages that reference the updated page are also re-established.
        Only relevance scores involving affected node pairs are recomputed.

        Parameters
        ----------
        page_path:
            Relative path of the page within the ``wiki/`` directory
            (e.g. ``"entities/entity_a.md"``).

        Returns
        -------
        nx.Graph:
            The updated graph.

        Raises
        ------
        FileNotFoundError:
            If the page file does not exist on disk.
        """
        self._ensure_graph_loaded()

        full_path = self._wiki_path / page_path
        if not full_path.exists():
            raise FileNotFoundError(f"Wiki page not found: {full_path}")

        # Collect the old neighbours *before* removing the node
        old_neighbours: set[str] = set()
        if self._graph.has_node(page_path):
            old_neighbours = set(self._graph.neighbors(page_path))
            self._graph.remove_node(page_path)

        # Re-parse the page
        content = full_path.read_text(encoding="utf-8")
        metadata = WikiGraphBuilder._parse_frontmatter(content)
        metadata["page_path"] = page_path
        metadata["file_path"] = str(full_path)

        # Build a title → path index (before adding the new node,
        # so existing pages can be resolved as forward-link targets).
        title_index = self._build_title_index()

        # Add the node
        WikiGraphBuilder._add_node(self._graph, page_path, metadata)

        # Rebuild index *after* the node is added so backlink
        # resolution can find the new page by title.
        title_index = self._build_title_index()
        node_meta = self._collect_node_meta()

        # Add forward wikilink edges (from the changed page → others)
        links = WikiGraphBuilder._extract_wikilinks(content)
        for link in links:
            target = WikiGraphBuilder._resolve_wikilink(link, title_index, node_meta)
            if target and target != page_path:
                self._graph.add_edge(page_path, target, type="wikilink")

        # Add backlink edges (other pages → changed page)
        self._add_backlinks(page_path, title_index, node_meta)

        # Recompute relevance only for affected node pairs
        self._recompute_affected_weights(page_path, old_neighbours)

        self._save_cache()
        return self._graph

    def remove_page(self, page_path: str) -> nx.Graph:
        """Remove a page and all its edges from the graph.

        Parameters
        ----------
        page_path:
            Relative path of the page to remove.

        Returns
        -------
        nx.Graph:
            The updated graph (without the removed page).

        Raises
        ------
        ValueError:
            If the page does not exist in the graph.
        """
        self._ensure_graph_loaded()

        if not self._graph.has_node(page_path):
            raise ValueError(f"Page not found in graph: {page_path}")

        self._graph.remove_node(page_path)
        self._save_cache()
        return self._graph

    def needs_rebuild(self) -> bool:
        """Check whether a full rebuild is necessary.

        Returns ``True`` if:
        * The cache file does not exist, **or**
        * Any ``.md`` file in the wiki directory was modified after the
          last build time.

        Returns
        -------
        bool:
            ``True`` if a full rebuild is recommended.
        """
        if not self._cache_path.exists():
            return True

        if not self._wiki_path.exists():
            return False

        for md_file in self._wiki_path.rglob("*.md"):
            mtime = md_file.stat().st_mtime
            if mtime > self._last_build_time:
                return True

        return False

    # ------------------------------------------------------------------
    # Cache management
    # ------------------------------------------------------------------

    def _save_cache(self) -> None:
        """Persist the current graph to disk as JSON."""
        self._cache_dir.mkdir(parents=True, exist_ok=True)

        payload = _graph_to_json(self._graph)
        payload["_last_build_time"] = self._last_build_time
        payload["_wiki_path"] = str(self._wiki_path)

        self._cache_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def _load_cache(self) -> nx.Graph | None:
        """Load the graph from the disk cache.

        Returns ``None`` if the cache is missing, invalid, or refers to a
        different wiki directory.
        """
        if not self._cache_path.exists():
            return None

        try:
            payload = json.loads(self._cache_path.read_text(encoding="utf-8"))

            # Version check
            if payload.get("version") != _CACHE_VERSION:
                return None

            # Wiki path check — avoid loading a cache for a different project
            if payload.get("_wiki_path") != str(self._wiki_path):
                return None

            self._last_build_time = payload.get("_last_build_time", 0.0)
            return _json_to_graph(payload)
        except (json.JSONDecodeError, KeyError, TypeError):
            return None

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _ensure_graph_loaded(self) -> None:
        """Load graph from cache or perform a full build if needed."""
        if self._graph is not None:
            return

        cached = self._load_cache()
        if cached is not None:
            self._graph = cached
        else:
            self.build_full()

    def _build_title_index(self) -> dict[str, str]:
        """Build a title → relative_path index from the current graph nodes.

        Returns
        -------
        dict:
            Lowercased title → relative page path.
        """
        index: dict[str, str] = {}
        for node_id, data in self._graph.nodes(data=True):
            title = (data.get("title") or "").strip().lower()
            if title:
                index[title] = node_id
        return index

    def _collect_node_meta(self) -> dict[str, dict]:
        """Build a page_path → metadata dict from the current graph nodes.

        Returns
        -------
        dict:
            Relative path → metadata dict.
        """
        meta: dict[str, dict] = {}
        for node_id, data in self._graph.nodes(data=True):
            meta[node_id] = dict(data)
        return meta

    def _add_backlinks(
        self,
        page_path: str,
        title_index: dict[str, str],
        node_meta: dict[str, dict],
    ) -> None:
        """Re-add edges from other pages that link to *page_path*.

        When a page is updated, removing its node also removes all
        incident edges — including wikilinks that *other* pages had
        pointing to it.  This method re-scans the other wiki markdown
        files and re-creates those edges.

        Parameters
        ----------
        page_path:
            The page that was just updated.
        title_index:
            Lowercased title → relative page path index.
        node_meta:
            All node metadata (relative path → dict).
        """
        target_lower = page_path.lower().replace("\\", "/")

        for other_id in list(self._graph.nodes()):
            if other_id == page_path:
                continue

            other_full = self._wiki_path / other_id
            if not other_full.exists():
                continue

            other_content = other_full.read_text(encoding="utf-8")
            other_links = WikiGraphBuilder._extract_wikilinks(other_content)

            for link in other_links:
                resolved = WikiGraphBuilder._resolve_wikilink(
                    link, title_index, node_meta
                )
                if resolved and resolved == page_path:
                    if not self._graph.has_edge(other_id, page_path):
                        self._graph.add_edge(
                            other_id, page_path, type="wikilink"
                        )

    def _recompute_affected_weights(
        self,
        changed_page: str,
        old_neighbours: set[str],
    ) -> None:
        """Recompute relevance weights for edges involving *changed_page*.

        Covers all node pairs where the Adamic-Adar signal could have
        shifted due to the change.  The affected set is expanded to
        include the 2-hop neighbourhood of *changed_page*.

        Parameters
        ----------
        changed_page:
            The page that was updated.
        old_neighbours:
            Set of nodes that were neighbours *before* the update (needed
            to clean up stale weights for edges that may no longer exist).
        """
        if not self._graph.has_node(changed_page):
            return

        current_neighbours = set(self._graph.neighbors(changed_page))

        # Build affected set: 1-hop + 2-hop neighbours + old neighbours
        affected: set[str] = {changed_page}
        affected.update(current_neighbours)
        affected.update(old_neighbours)
        # Expand to 2-hop: neighbours of each direct neighbour
        for n in list(affected):
            if self._graph.has_node(n):
                affected.update(self._graph.neighbors(n))

        # Remove any stale nodes
        affected = {n for n in affected if self._graph.has_node(n)}

        # ---- Phase 1: changed_page ↔ every other affected node ----
        for node in affected:
            if node == changed_page:
                continue
            self._set_edge_weight(changed_page, node)

        # ---- Phase 2: all other pairs within the affected set ----
        affected_list = sorted(affected - {changed_page})
        for i, a in enumerate(affected_list):
            for b in affected_list[i + 1 :]:
                self._set_edge_weight(a, b)

    def _set_edge_weight(self, a: str, b: str) -> None:
        """Compute and set (or remove) the weight for edge *a*‑*b*.

        If the computed weight is zero and the edge exists it is removed.
        If the weight is positive the edge is created or updated.
        """
        w = self._model.compute_weight(self._graph, a, b)
        if w > 0:
            if self._graph.has_edge(a, b):
                self._graph[a][b]["weight"] = round(w, 4)
            else:
                self._graph.add_edge(a, b, weight=round(w, 4))
        else:
            if self._graph.has_edge(a, b):
                self._graph.remove_edge(a, b)
