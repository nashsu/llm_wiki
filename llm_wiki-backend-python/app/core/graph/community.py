"""Community detection using a simplified Louvain-like algorithm.

The implementation follows the modularity-optimisation spirit of the
Louvain method without depending on external community-detection libraries.

Algorithm sketch
----------------
1. Start with each node in its own community.
2. For each node, consider moving it to a neighbour's community and keep
   the move that yields the greatest modularity gain.
3. Repeat until no move increases modularity.
4. Collapse the graph (aggregate communities into super-nodes) and repeat
   from step 1 until modularity stops improving.
"""

from __future__ import annotations

from collections import defaultdict

import networkx as nx

# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def detect_communities(
    graph: nx.Graph,
    resolution: float = 1.0,
    max_passes: int = 10,
) -> list[set[str]]:
    """Detect communities in *graph* using a simplified Louvain algorithm.

    Args:
        graph: An undirected NetworkX graph.
        resolution: Modularity resolution parameter (> 1 favours smaller
            communities; < 1 favours larger ones).
        max_passes: Maximum number of Louvain passes (each pass does
            local-moving + aggregation).

    Returns:
        A list of sets, where each set contains the node identifiers of one
        community.
    """
    # Work on a copy so we don't mutate the original
    g = graph.copy()
    node_to_community = {n: i for i, n in enumerate(g.nodes())}

    for _pass in range(max_passes):
        changed = _local_moving_phase(g, node_to_community, resolution)
        if not changed:
            break
        # Aggregation phase — collapse communities into super-nodes
        g, node_to_community = _aggregate(g, node_to_community)

    # Build the result: map community id → set of original nodes
    communities: dict[int, set[str]] = defaultdict(set)
    for node, cid in node_to_community.items():
        communities[cid].add(node)

    return sorted(list(c) for c in communities.values())


def compute_cohesion(graph: nx.Graph, community: set[str]) -> float:
    """Compute the internal cohesion (edge density) of a community.

    Cohesion = (actual internal edges) / (maximum possible edges).
    A value close to 1 means a tightly-knit community; < 0.15 is sparse.

    Args:
        graph: The full graph.
        community: Set of node identifiers belonging to the community.

    Returns:
        Cohesion score in [0, 1].
    """
    n = len(community)
    if n < 2:
        return 0.0

    internal = 0
    for u in community:
        for v in graph.neighbors(u):
            if v in community:
                internal += 1

    # Each edge counted twice above, so divide by 2
    internal //= 2
    max_edges = n * (n - 1) // 2
    if max_edges == 0:
        return 0.0
    return internal / max_edges


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _local_moving_phase(
    graph: nx.Graph,
    node_to_community: dict[str, int],
    resolution: float,
) -> bool:
    """Iterate over all nodes, moving each to its best community.

    Returns True if any move was made.
    """
    # Precompute total edge weight (2 * |E| for unweighted)
    m = graph.number_of_edges()

    changed = False
    nodes = list(graph.nodes())

    for node in nodes:
        current_comm = node_to_community[node]
        best_comm = current_comm
        best_gain = 0.0

        # Compute degree of node
        k_i = graph.degree(node)

        # Compute sum of degrees in each neighbour community
        neighbour_comm_sums: dict[int, float] = defaultdict(float)
        for neighbour in graph.neighbors(node):
            nc = node_to_community[neighbour]
            neighbour_comm_sums[nc] += 1.0  # unweighted: each edge = 1

        # For each neighbour's community, compute gain from moving
        # ΔQ = [Σ_in + 2*k_i_in] / (2*m) - resolution * [(Σ_tot + k_i) / (2*m)]²
        #      - [Σ_in / (2*m) - resolution * (Σ_tot / (2*m))² - (k_i / (2*m))²]
        # Simplified: we only evaluate neighbour communities that appear.
        for comm, k_i_in in neighbour_comm_sums.items():
            if comm == current_comm:
                continue

            # Σ_tot: total degree of nodes in target community
            sigma_tot = sum(
                graph.degree(n) for n in nodes if node_to_community[n] == comm
            )
            # Σ_in: internal edges within target community
            sigma_in = _community_internal_edges(graph, nodes, node_to_community, comm)

            # Gain formula for unweighted Louvain
            gain = (
                (sigma_in + 2 * k_i_in) / (2 * m)
                - resolution * ((sigma_tot + k_i) / (2 * m)) ** 2
                - sigma_in / (2 * m)
                + resolution * (sigma_tot / (2 * m)) ** 2
                + resolution * (k_i / (2 * m)) ** 2
            )

            if gain > best_gain:
                best_gain = gain
                best_comm = comm

        if best_comm != current_comm:
            node_to_community[node] = best_comm
            changed = True

    return changed


def _community_internal_edges(
    graph: nx.Graph,
    nodes: list[str],
    node_to_community: dict[str, int],
    comm: int,
) -> float:
    """Count internal edges within a community (each edge counted once)."""
    internal = 0
    for u in nodes:
        if node_to_community[u] != comm:
            continue
        for v in graph.neighbors(u):
            if node_to_community[v] == comm and u < v:
                internal += 1
    return float(internal)


def _aggregate(
    graph: nx.Graph,
    node_to_community: dict[str, int],
) -> tuple[nx.Graph, dict[str, int]]:
    """Collapse communities into super-nodes (first aggregation level).

    For simplicity, this returns the original graph unchanged but with
    community assignments preserved — our simplified implementation does
    not perform multi-level aggregation. Instead, we run the local-moving
    phase on the original graph multiple times.

    This approach trades some deep hierarchy for simplicity and still
    produces meaningful communities.
    """
    # For a simplified single-level Louvain, we just return the graph as-is
    # with updated community assignments from the local moving phase.
    return graph, node_to_community
