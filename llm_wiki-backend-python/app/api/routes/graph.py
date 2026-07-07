"""API routes for the knowledge graph."""

import json
import logging
from pathlib import Path
from urllib.parse import unquote

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from app.core.graph import WikiGraphBuilder, RelevanceModel, GraphInsights

logger = logging.getLogger("llm-wiki")

router = APIRouter(prefix="/graph", tags=["graph"])

_builder = WikiGraphBuilder
_relevance = RelevanceModel()
_insights = GraphInsights()


def _load_graph(project_path: str) -> "nx.Graph":
    """Build the graph for a given project path.

    Args:
        project_path: Absolute filesystem path to the project.

    Returns:
        A NetworkX Graph.

    Raises:
        HTTPException 404 if the wiki directory does not exist.
    """
    import networkx as nx  # noqa: F811

    wiki_dir = Path(project_path) / "wiki"
    if not wiki_dir.is_dir():
        raise HTTPException(
            status_code=404,
            detail=f"Wiki directory not found at {wiki_dir}",
        )
    builder = _builder(wiki_dir)
    graph = builder.build()
    return _relevance.compute_all_weights(graph)


def _graph_to_json(graph: "nx.Graph") -> dict:
    """Convert a NetworkX graph to a JSON-serializable dict.

    Returns ``{"nodes": [...], "edges": [...]}`` suitable for sigma.js.
    """
    nodes = []
    for node, data in graph.nodes(data=True):
        nodes.append({
            "id": node,
            "label": data.get("title", node),
            "type": data.get("type", "unknown"),
            "page_path": data.get("page_path", node),
            "degree": graph.degree(node),
        })

    edges = []
    for u, v, data in graph.edges(data=True):
        edges.append({
            "source": u,
            "target": v,
            "weight": data.get("weight", 1.0),
            "edge_type": data.get("type", "relevance"),
        })

    return {"nodes": nodes, "edges": edges}


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/{project_path:path}/data")
async def get_graph_data(project_path: str):
    """Return the full graph data (nodes + edges) as JSON.

    The ``project_path`` should be URL-encoded.
    """
    decoded = unquote(project_path)
    logger.info("Graph data requested for project: %s", decoded)
    graph = _load_graph(decoded)
    return _graph_to_json(graph)


@router.get("/{project_path:path}/community")
async def get_community(project_path: str):
    """Return community detection results.

    Returns communities with their members and cohesion scores.
    """
    from app.core.graph.community import compute_cohesion, detect_communities

    decoded = unquote(project_path)
    logger.info("Community detection requested for project: %s", decoded)
    graph = _load_graph(decoded)
    communities = detect_communities(graph)

    result = []
    for cid, members in enumerate(communities):
        cohesion = compute_cohesion(graph, members)
        result.append({
            "community_id": cid,
            "size": len(members),
            "cohesion": round(cohesion, 4),
            "members": sorted(members),
        })

    return {"communities": result, "count": len(result)}


@router.get("/{project_path:path}/insights")
async def get_insights(project_path: str):
    """Return graph insights (surprising connections + knowledge gaps)."""
    decoded = unquote(project_path)
    logger.info("Insights requested for project: %s", decoded)
    graph = _load_graph(decoded)
    return _insights.get_insights(graph)


@router.get("/{project_path:path}/related/{page_path:path}")
async def get_related_pages(project_path: str, page_path: str):
    """Return related pages for a given wiki page.

    Both ``project_path`` and ``page_path`` should be URL-encoded.
    """
    decoded_project = unquote(project_path)
    decoded_page = unquote(page_path)
    logger.info(
        "Related pages for %s in project: %s", decoded_page, decoded_project
    )
    graph = _load_graph(decoded_project)
    related = _relevance.get_related_pages(graph, decoded_page, top_k=10)
    return {"page": decoded_page, "related": related}
