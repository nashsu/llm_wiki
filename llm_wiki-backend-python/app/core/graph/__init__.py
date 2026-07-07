"""Knowledge graph package.

Provides graph construction, relevance modeling, community detection,
and insight discovery for wiki knowledge bases.
"""

from app.core.graph.builder import WikiGraphBuilder
from app.core.graph.relevance import RelevanceModel
from app.core.graph.community import detect_communities, compute_cohesion
from app.core.graph.insights import GraphInsights

__all__ = [
    "WikiGraphBuilder",
    "RelevanceModel",
    "detect_communities",
    "compute_cohesion",
    "GraphInsights",
]
