"""Reciprocal Rank Fusion (RRF) for merging multiple ranked result lists.

RRF combines ranking signals from keyword search and vector search by
summing reciprocal ranks across sources.
"""

from __future__ import annotations

from typing import Any


class RRFFusion:
    """Fuse multiple ranked result lists using Reciprocal Rank Fusion.

    The RRF score for a document *d* that appears in *S* search sources is::

        score(d) = SUM_s( 1 / (k + rank_s(d)) )

    where *k* (default 60) is a smoothing constant and *rank_s(d)* is
    the 1-based rank of *d* within source *s*.

    Usage::

        fusion = RRFFusion()
        fused = fusion.fuse(
            keyword_results=[{"path": "a.md", ...}, ...],
            vector_results=[{"id": "a.md", ...}, ...],
        )
    """

    def fuse(
        self,
        keyword_results: list[dict[str, Any]],
        vector_results: list[dict[str, Any]],
        k: int = 60,
        keyword_weight: float = 1.0,
        vector_weight: float = 1.0,
    ) -> list[dict[str, Any]]:
        """Fuse *keyword_results* and *vector_results* via RRF.

        Parameters
        ----------
        keyword_results:
            Ranked list from keyword search.  Each dict should contain a
            ``"path"`` key for identity matching.
        vector_results:
            Ranked list from vector search.  Each dict should contain an
            ``"id"`` or ``"path"`` key for identity matching.
        k:
            RRF smoothing constant (standard academic value is 60).
        keyword_weight:
            Multiplier for keyword-sourced rank contributions.
        vector_weight:
            Multiplier for vector-sourced rank contributions.

        Returns
        -------
        list[dict]:
            Merged results sorted by fused score descending.  Each dict
            gains a ``"score"`` field with the final RRF score.
        """
        # Accumulate RRF scores per document identity key
        scores: dict[str, dict[str, Any]] = {}

        for rank, result in enumerate(keyword_results):
            key = result.get("path", str(rank))
            rrf_score = keyword_weight / (k + rank + 1)  # +1 because rank is 0‑based
            entry = dict(result)
            entry["score"] = rrf_score
            entry["_vector_score"] = 0.0
            scores[key] = entry

        for rank, result in enumerate(vector_results):
            key = result.get("id") or result.get("path") or str(rank)
            rrf_score = vector_weight / (k + rank + 1)
            if key in scores:
                scores[key]["score"] += rrf_score
                scores[key]["_vector_score"] = rrf_score
            else:
                entry = dict(result)
                entry["score"] = rrf_score
                entry["_vector_score"] = rrf_score
                # Ensure a consistent identity key
                entry.setdefault("path", key)
                scores[key] = entry

        # Sort descending by fused score
        results = sorted(scores.values(), key=lambda x: x["score"], reverse=True)

        # Clean internal tracking fields
        for r in results:
            r.pop("_vector_score", None)

        return results
