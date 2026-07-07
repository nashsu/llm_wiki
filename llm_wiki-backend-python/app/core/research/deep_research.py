"""Deep research orchestrator.

The ``DeepResearcher`` uses an LLM to:
1. Generate research topics and optimised search queries based on the
   Wiki's purpose and current overview.
2. Execute web searches via a ``WebSearcher``.
3. Synthesise search results into structured Wiki research pages (with
   YAML frontmatter).
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime
from pathlib import Path
from typing import Any

from langchain_core.language_models import BaseChatModel

from app.core.prompts import PromptManager
from app.core.research.web_search import WebSearcher

logger = logging.getLogger("llm-wiki")

# ── Helpers ────────────────────────────────────────────────────────────


def _extract_json(text: str) -> dict[str, Any] | None:
    """Try to extract the first JSON object from *text*.

    Searches for a ``{`` … ``}`` block.  If found, attempts to parse it
    with ``json.loads``.

    Returns:
        The parsed dict, or ``None`` if no valid JSON was found.
    """
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if match is None:
        return None
    try:
        return json.loads(match.group())
    except json.JSONDecodeError:
        return None


def _make_frontmatter(topic: str) -> str:
    """Generate YAML frontmatter for a research page."""
    date_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    return (
        "---\n"
        f"title: {topic!r}\n"
        f"type: research\n"
        f"created: {date_str}\n"
        "sources: []\n"
        "---\n\n"
    )


def _write_page(project_path: Path, topic: str, content: str) -> Path:
    """Write a research page to ``wiki/research/`` under the project.

    The page slug is derived from the topic: lowercase, hyphens for spaces,
    no special characters.

    Returns:
        The absolute path of the written file.
    """
    slug = re.sub(r"[^a-z0-9\s-]", "", topic.lower())
    slug = re.sub(r"[\s-]+", "-", slug).strip("-") or "research"
    page_dir = project_path / "wiki" / "research"
    page_dir.mkdir(parents=True, exist_ok=True)
    page_path = page_dir / f"{slug}.md"

    frontmatter = _make_frontmatter(topic)
    full_content = frontmatter + content
    page_path.write_text(full_content, encoding="utf-8")
    logger.info("Research page written: %s", page_path)
    return page_path


# ── DeepResearcher ─────────────────────────────────────────────────────


class DeepResearcher:
    """Orchestrate deep research: topic generation → search → synthesis.

    Args:
        llm: A LangChain ``BaseChatModel`` used for topic generation and
            synthesis.
        searcher: A ``WebSearcher`` instance that executes queries.
        prompt_manager: A ``PromptManager`` used to load prompt templates.
    """

    def __init__(
        self,
        llm: BaseChatModel,
        searcher: WebSearcher,
        prompt_manager: PromptManager,
    ) -> None:
        self._llm = llm
        self._searcher = searcher
        self._prompt_manager = prompt_manager

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def generate_topics(self, context: dict[str, Any]) -> list[dict[str, Any]]:
        """Use the LLM to generate research topics and search queries.

        The LLM reads ``context`` which should contain the Wiki's
        ``purpose.md`` and ``overview.md`` content, then returns a list of
        topics, each with an optimised search query.

        Args:
            context: A dict that must include at least ``purpose`` and
                ``overview`` keys.

        Returns:
            A list of dicts: ``[{"topic": "...", "query": "..."}, ...]``.
        """
        purpose = context.get("purpose", "")
        overview = context.get("overview", "")

        prompt = self._prompt_manager.render(
            "deep-research-topics",
            purpose=purpose,
            overview=overview,
        )
        response = self._llm.invoke(prompt)
        raw = response.content if hasattr(response, "content") else str(response)

        parsed = _extract_json(raw)
        if parsed and "topics" in parsed:
            return parsed["topics"]
        # Fallback: treat the whole response as a single topic
        return [{"topic": raw.strip(), "query": raw.strip()}]

    def research(self, topics: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Execute web searches for each topic.

        Args:
            topics: A list of topic dicts as returned by ``generate_topics``.

        Returns:
            A list of result dicts, each with keys ``topic``, ``query``,
            ``results`` (list of search result dicts).
        """
        outcomes: list[dict[str, Any]] = []
        for item in topics:
            topic = item.get("topic", "")
            query = item.get("query", topic)
            logger.info("Researching topic: %s (query: %s)", topic, query)
            try:
                results = self._searcher.search(query)
            except Exception:
                logger.exception("Search failed for topic: %s", topic)
                results = []
            outcomes.append({"topic": topic, "query": query, "results": results})
        return outcomes

    def synthesize(
        self,
        topic: str,
        search_results: list[dict[str, Any]],
        context: dict[str, Any] | None = None,
    ) -> str:
        """Synthesise search results into a structured research summary.

        Uses the LLM to analyse results and generate a Wiki-style page
        with sections.

        Args:
            topic: The research topic.
            search_results: List of normalised result dicts from the
                ``WebSearcher``.
            context: Optional extra context (e.g. current Wiki pages).

        Returns:
            Markdown content for the research page (without frontmatter).
        """
        # Format search results for the prompt
        lines: list[str] = []
        for i, r in enumerate(search_results, 1):
            lines.append(f"### Result {i}: {r.get('title', 'Untitled')}")
            lines.append(f"- **URL**: {r.get('url', 'N/A')}")
            lines.append(f"- **Score**: {r.get('score', 'N/A')}")
            lines.append("")
            lines.append(r.get("content", "No content"))
            lines.append("")
        search_text = "\n".join(lines)

        ctx = context or {}
        related_pages = ctx.get("related_pages", "None available.")
        purpose = ctx.get("purpose", "")
        language_directive = ctx.get("language_directive", "Respond in the same language as the Wiki.")

        prompt = self._prompt_manager.render(
            "deep-research",
            purpose=purpose,
            search_results=search_text,
            related_pages=related_pages,
            language_directive=language_directive,
        )
        response = self._llm.invoke(prompt)
        return response.content if hasattr(response, "content") else str(response)

    def run(
        self,
        project_path: Path,
        topic: str | None = None,
        context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Run the full deep research pipeline.

        1. Generate topics (or use the provided *topic*).
        2. Search for each topic.
        3. Synthesise results into a research page.
        4. Write the page to ``wiki/research/``.

        Args:
            project_path: Root path of the Wiki project.
            topic: Optional single topic to research.  If not provided,
                topics are generated from the Wiki context.
            context: Optional dict with ``purpose``, ``overview``,
                ``related_pages``, ``language_directive``.

        Returns:
            A dict::

                {
                    "topic": str,
                    "search_results": [...],
                    "synthesis": str,
                    "page_written": str | None,  # absolute path
                }
        """
        ctx = context or {}

        # 1. Generate / resolve topics
        if topic:
            topics = [{"topic": topic, "query": topic}]
        else:
            topics = self.generate_topics(ctx)

        # 2. Search
        outcomes = self.research(topics)

        # 3. Synthesise — use the first topic's results
        primary = outcomes[0] if outcomes else {"topic": topic or "Unknown", "results": []}
        synthesis = self.synthesize(primary["topic"], primary["results"], ctx)

        # 4. Write page
        try:
            page_path = _write_page(project_path, primary["topic"], synthesis)
            page_written = str(page_path)
        except Exception:
            logger.exception("Failed to write research page")
            page_written = None

        return {
            "topic": primary["topic"],
            "search_results": primary["results"],
            "synthesis": synthesis,
            "page_written": page_written,
        }
