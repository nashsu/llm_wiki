"""Context builder for the Wiki Chat Agent.

The ``ContextBuilder`` searches the Wiki for relevant pages and assembles
them into a structured context dict that can be used to render the
``chat-agent-answer`` prompt template.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any


class ContextBuilder:
    """Build a structured context dict from Wiki search results.

    Usage::

        builder = ContextBuilder()
        ctx = builder.build_context(
            query="Python programming",
            project_path="/path/to/wiki",
            search_engine=my_engine,
        )
        # ctx = {"pages": [...], "total_tokens": ...}
    """

    @staticmethod
    def estimate_tokens(text: str) -> int:
        """Estimate the number of tokens in *text*.

        Uses a simple heuristic: ``len(text) / 4``, which is a reasonable
        approximation for English and code.
        """
        return max(1, len(text) // 4)

    @staticmethod
    def _load_page_content(
        project_path: str,
        page_path: str,
        max_chars: int = 8000,
    ) -> str:
        """Load the text content of a Wiki page, truncated to *max_chars*."""
        full = Path(project_path).resolve() / page_path
        if not full.is_file():
            return ""
        try:
            text = full.read_text(encoding="utf-8")
            return text[:max_chars]
        except Exception:
            return ""

    @staticmethod
    def _infer_title(page_path: str) -> str:
        """Infer a human-readable title from a file path."""
        stem = Path(page_path).stem
        return stem.replace("-", " ").replace("_", " ").title()

    def build_context(
        self,
        query: str,
        project_path: str,
        search_engine: Any,
        max_tokens: int = 4000,
    ) -> dict[str, Any]:
        """Search the Wiki and build a context dict.

        Parameters
        ----------
        query:
            The user's query or search string.
        project_path:
            Absolute filesystem path to the Wiki project.
        search_engine:
            A search engine instance with a ``search(query)`` method
            returning ``list[dict]`` containing at least ``path`` and
            optionally ``snippet`` or ``score`` keys.
        max_tokens:
            Maximum total tokens the context pages may consume.

        Returns
        -------
        dict:
            ``{"pages": list[dict], "total_tokens": int}`` where each page
            dict has keys: ``path``, ``title``, ``content``, ``score``.
        """
        # 1. Search
        try:
            results = search_engine.search(query)
        except Exception:
            results = []

        if not results:
            return {"pages": [], "total_tokens": 0}

        # 2-3. Load content and sort by score descending
        pages: list[dict[str, Any]] = []
        for r in results:
            page_path = r.get("path", "")
            if not page_path:
                continue
            content = self._load_page_content(project_path, page_path)
            pages.append(
                {
                    "path": page_path,
                    "title": self._infer_title(page_path),
                    "content": content,
                    "score": r.get("score", 0),
                }
            )

        pages.sort(key=lambda p: p["score"], reverse=True)

        # 4. Truncate by token budget
        total_tokens = 0
        selected: list[dict[str, Any]] = []
        for page in pages:
            tokens = self.estimate_tokens(page["content"])
            if total_tokens + tokens > max_tokens:
                remaining = max_tokens - total_tokens
                # Truncate content of this page to fit remaining budget
                if remaining > 10:
                    truncated_chars = remaining * 4
                    page["content"] = page["content"][:truncated_chars]
                    page["content"] += "\n[... truncated]"
                    page["tokens"] = remaining
                    selected.append(page)
                    total_tokens += remaining
                break
            page["tokens"] = tokens
            selected.append(page)
            total_tokens += tokens

        return {"pages": selected, "total_tokens": total_tokens}
