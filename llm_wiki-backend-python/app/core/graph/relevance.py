"""Four-signal relevance model for wiki graph edges.

Signals (weights are multiplicative):
  1. **Direct link**  (×3.0)  – pages connected by a [[wikilink]].
  2. **Source overlap** (×4.0) – pages sharing a source document in their
     ``sources[]`` frontmatter.
  3. **Adamic-Adar**  (×1.5)  – pages that share many neighbours, weighted by
     the inverse log-degree of each neighbour (common in information networks).
  4. **Type affinity** (×1.0) – pages of the same ``type`` (entity ↔ entity,
     concept ↔ concept) get a small boost.

The final weight for an edge is the **sum** of all applicable signals.
"""

from __future__ import annotations

import math
from typing import Any

import networkx as nx


class RelevanceModel:
    """Computes multi-signal edge weights for a wiki graph."""

    # Signal weights
    DIRECT_LINK_W = 3.0
    SOURCE_OVERLAP_W = 4.0
    ADAMIC_ADAR_W = 1.5
    TYPE_AFFINITY_W = 1.0

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def compute_weight(
        self, graph: nx.Graph, node_a: str, node_b: str
    ) -> float:
        """Compute the combined relevance weight between two nodes.

        Args:
            graph: The wiki graph.
            node_a: First node identifier.
            node_b: Second node identifier.

        Returns:
            Combined relevance score (sum of weighted signals).
        """
        weight = 0.0

        if self._has_direct_link(graph, node_a, node_b):
            weight += self.DIRECT_LINK_W

        source_score = self._source_overlap(graph, node_a, node_b)
        weight += self.SOURCE_OVERLAP_W * source_score

        aa_score = self._adamic_adar(graph, node_a, node_b)
        weight += self.ADAMIC_ADAR_W * aa_score

        type_score = self._type_affinity(graph, node_a, node_b)
        weight += self.TYPE_AFFINITY_W * type_score

        return weight

    def get_related_pages(
        self,
        graph: nx.Graph,
        page_path: str,
        top_k: int = 10,
    ) -> list[dict[str, Any]]:
        """Return the top-*k* most relevant pages for a given page.

        Results are sorted by descending relevance weight.

        Args:
            graph: The wiki graph.
            page_path: The source page to find relations for.
            top_k: Maximum number of results to return.

        Returns:
            A list of dicts ``{"page": str, "weight": float}``.
        """
        if page_path not in graph:
            return []

        scored: list[tuple[float, str]] = []
        for other in graph.nodes():
            if other == page_path:
                continue
            w = self.compute_weight(graph, page_path, other)
            if w > 0:
                scored.append((w, other))

        scored.sort(key=lambda x: (-x[0], x[1]))
        return [
            {"page": page, "weight": round(weight, 4)}
            for weight, page in scored[:top_k]
        ]

    def compute_all_weights(self, graph: nx.Graph) -> nx.Graph:
        """Add or update ``weight`` attributes on every edge.

        Edges that already exist get their weight updated; new edges are
        created only if at least one signal fires (weight > 0).
        The original graph is **not** mutated — a new graph is returned.

        Args:
            graph: Input graph (nodes + wikilink edges).

        Returns:
            A new graph with weighted edges.
        """
        result = graph.copy()

        nodes = list(result.nodes())
        for i, a in enumerate(nodes):
            for b in nodes[i + 1 :]:
                w = self.compute_weight(result, a, b)
                if w > 0:
                    if result.has_edge(a, b):
                        result[a][b]["weight"] = round(w, 4)
                    else:
                        result.add_edge(a, b, weight=round(w, 4))

        return result

    # ------------------------------------------------------------------
    # Signal implementations
    # ------------------------------------------------------------------

    @staticmethod
    def _has_direct_link(graph: nx.Graph, a: str, b: str) -> bool:
        """Check if two nodes are directly connected by a wikilink edge."""
        return graph.has_edge(a, b)

    @staticmethod
    def _source_overlap(graph: nx.Graph, a: str, b: str) -> float:
        """Compute Jaccard similarity of the ``sources[]`` arrays.

        Returns 0 if either node has no sources.
        Returns a float in [0, 1].
        """
        sources_a = set(graph.nodes[a].get("sources", []) or [])
        sources_b = set(graph.nodes[b].get("sources", []) or [])

        if not sources_a or not sources_b:
            return 0.0

        intersection = sources_a & sources_b
        if not intersection:
            return 0.0

        return len(intersection) / len(sources_a | sources_b)

    @staticmethod
    def _adamic_adar(graph: nx.Graph, a: str, b: str) -> float:
        """Adamic-Adar index: sum over common neighbours of 1/log(deg(z)).

        Higher values mean stronger connection through shared neighbours.
        Returns 0 if no common neighbours.
        """
        # Use networkx built-in for efficiency
        try:
            # networkx has a built-in adamic_adar_index but it returns an iterator
            # We'll compute manually for clarity
            common = nx.common_neighbors(graph, a, b)
        except nx.NetworkXError:
            return 0.0

        score = 0.0
        for neighbour in common:
            deg = graph.degree(neighbour)
            if deg > 1:
                score += 1.0 / math.log(deg)
        return score

    @staticmethod
    def _type_affinity(graph: nx.Graph, a: str, b: str) -> float:
        """Return 1 if both nodes have the same non-unknown ``type``, else 0."""
        type_a = graph.nodes[a].get("type", "unknown")
        type_b = graph.nodes[b].get("type", "unknown")
        if type_a != "unknown" and type_a == type_b:
            return 1.0
        return 0.0
