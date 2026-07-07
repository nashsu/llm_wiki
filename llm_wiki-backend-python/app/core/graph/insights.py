"""Graph insights: surprising connections and knowledge gaps."""

from __future__ import annotations

from collections import defaultdict
from typing import Any

import networkx as nx

from app.core.graph.community import compute_cohesion, detect_communities

# Minimum community size considered meaningful
MIN_COMMUNITY_SIZE = 3

# Edge rarity threshold (bottom 25% of inter-community edges)
RARITY_PERCENTILE = 0.25


class GraphInsights:
    """Discover surprising connections and knowledge gaps in a wiki graph."""

    # ------------------------------------------------------------------
    # Surprising connections
    # ------------------------------------------------------------------

    @staticmethod
    def find_surprising_connections(
        graph: nx.Graph,
    ) -> list[dict[str, Any]]:
        """Find unexpected or surprising relationships in the graph.

        Three heuristics are used:
        1. **Cross-community edges** — edges that connect different communities.
        2. **Cross-type edges** — edges between different page types.
        3. **Hub–periphery coupling** — edges linking high-degree (hub) nodes
           to low-degree (periphery) nodes.

        Each connection receives a *surprise score* that is the sum of all
        applicable heuristics.  Results are sorted descending by score.

        Args:
            graph: A weighted wiki graph.

        Returns:
            List of dicts, each with keys:
            ``source``, ``target``, ``weight``, ``surprise_score``,
            ``reasons`` (list of strings).
        """
        communities = detect_communities(graph, resolution=1.2)
        comm_of: dict[str, int] = {}
        for cid, members in enumerate(communities):
            for m in members:
                comm_of[m] = cid

        degrees = dict(graph.degree())
        if degrees:
            median_deg = sorted(degrees.values())[len(degrees) // 2]
        else:
            median_deg = 0

        surprising: list[dict[str, Any]] = []

        for u, v, data in graph.edges(data=True):
            reasons: list[str] = []
            score = 0.0

            # 1. Cross-community edge
            if comm_of.get(u) != comm_of.get(v):
                reasons.append("cross-community")
                score += 2.0

            # 2. Cross-type edge
            type_u = graph.nodes[u].get("type", "unknown")
            type_v = graph.nodes[v].get("type", "unknown")
            if type_u != "unknown" and type_v != "unknown" and type_u != type_v:
                reasons.append("cross-type")
                score += 1.5

            # 3. Hub–periphery coupling
            deg_u = degrees.get(u, 0)
            deg_v = degrees.get(v, 0)
            if median_deg > 0:
                if (deg_u >= median_deg * 2 and deg_v <= max(1, median_deg // 2)) or (
                    deg_v >= median_deg * 2 and deg_u <= max(1, median_deg // 2)
                ):
                    reasons.append("hub-periphery")
                    score += 1.0

            if reasons:
                weight = data.get("weight", 1.0)
                surprising.append({
                    "source": u,
                    "target": v,
                    "weight": weight,
                    "surprise_score": round(score, 4),
                    "reasons": reasons,
                    "source_type": type_u,
                    "target_type": type_v,
                })

        surprising.sort(key=lambda x: (-x["surprise_score"], -x["weight"]))
        return surprising

    # ------------------------------------------------------------------
    # Knowledge gaps
    # ------------------------------------------------------------------

    @staticmethod
    def find_knowledge_gaps(
        graph: nx.Graph,
    ) -> dict[str, list[dict[str, Any]]]:
        """Identify knowledge gaps in the wiki graph.

        Returns three categories:
        - **isolated**: nodes with degree ≤ 1 (few connections).
        - **sparse_communities**: communities with cohesion < 0.15 and
          at least ``MIN_COMMUNITY_SIZE`` members.
        - **bridges**: nodes that connect 3+ different communities.

        Args:
            graph: A weighted wiki graph.

        Returns:
            Dict with keys ``isolated``, ``sparse_communities``,
            ``bridges``, each containing a list of result dicts.
        """
        communities = detect_communities(graph, resolution=1.0)
        comm_of: dict[str, int] = {}
        for cid, members in enumerate(communities):
            for m in members:
                comm_of[m] = cid

        # --- Isolated nodes ---
        isolated: list[dict[str, Any]] = []
        for node in graph.nodes():
            deg = graph.degree(node)
            if deg <= 1:
                isolated.append({
                    "page": node,
                    "title": graph.nodes[node].get("title", node),
                    "degree": deg,
                })

        # --- Sparse communities ---
        sparse: list[dict[str, Any]] = []
        for cid, members in enumerate(communities):
            if len(members) < MIN_COMMUNITY_SIZE:
                continue
            cohesion = compute_cohesion(graph, members)
            if cohesion < 0.15:
                sparse.append({
                    "community_id": cid,
                    "members": sorted(members),
                    "size": len(members),
                    "cohesion": round(cohesion, 4),
                })

        # --- Bridge nodes (connect 3+ communities) ---
        bridge_map: dict[str, set[int]] = defaultdict(set)
        for u, v in graph.edges():
            cu = comm_of.get(u)
            cv = comm_of.get(v)
            if cu is not None and cv is not None and cu != cv:
                bridge_map[u].add(cv)
                bridge_map[v].add(cu)

        bridges: list[dict[str, Any]] = []
        for node, comms in bridge_map.items():
            if len(comms) >= 3:
                bridges.append({
                    "page": node,
                    "title": graph.nodes[node].get("title", node),
                    "connected_communities": sorted(comms),
                    "num_communities": len(comms),
                })

        bridges.sort(key=lambda x: -x["num_communities"])

        return {
            "isolated": isolated,
            "sparse_communities": sparse,
            "bridges": bridges,
        }

    # ------------------------------------------------------------------
    # Combined insight report
    # ------------------------------------------------------------------

    @staticmethod
    def get_insights(graph: nx.Graph) -> dict[str, Any]:
        """Return a combined insight report with both categories.

        Args:
            graph: A weighted wiki graph.

        Returns:
            Dict with keys ``surprising`` (list) and ``gaps`` (dict).
        """
        return {
            "surprising": GraphInsights.find_surprising_connections(graph),
            "gaps": GraphInsights.find_knowledge_gaps(graph),
        }
