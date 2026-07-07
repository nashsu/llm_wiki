"""Review engine — LLM-powered scanning of Wiki pages for human review.

The :class:`ReviewEngine` analyses individual wiki pages or the entire wiki
and produces structured review items that are fed into the
:class:`~app.core.review.queue.ReviewQueue` for human resolution.
"""

import json
import logging
import re
from pathlib import Path
from typing import Any

from langchain_core.language_models import BaseChatModel

from app.core.prompts.manager import PromptManager
from app.core.review.queue import ReviewItemType

logger = logging.getLogger(__name__)

_REVIEW_FIELDS = [
    "review_items",
]

_DEFAULT_REVIEW: dict[str, list] = {"review_items": []}


class ReviewEngine:
    """LLM-powered review engine for Wiki pages.

    Uses an LLM to analyse page content and flag items that need human
    attention (quality issues, missing sources, contradictions, stale
    content, or pages that should be deleted).
    """

    def __init__(
        self,
        llm: BaseChatModel,
        prompt_manager: PromptManager,
        wiki_path: Path,
    ) -> None:
        """Initialise the review engine.

        Parameters
        ----------
        llm : BaseChatModel
            LangChain chat model used for the review analysis.
        prompt_manager : PromptManager
            Used to load and render the ``review-scan`` prompt template.
        wiki_path : Path
            Absolute path to the project wiki directory (the directory
            containing ``wiki/``, ``raw/``, ``schema.md``, etc.).
        """
        self._llm = llm
        self._pm = prompt_manager
        self._wiki_path = wiki_path.resolve()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def scan_page(self, page_path: str) -> list[dict]:
        """Scan a single wiki page and return review items.

        The page content is read, sent to the LLM together with the
        project's schema and purpose, and the LLM response is parsed into
        a list of review item dicts.

        Parameters
        ----------
        page_path : str
            Relative path to the page within the wiki (e.g.
            ``"wiki/entities/my-entity.md"`` or an absolute path).

        Returns
        -------
        list[dict]
            List of review item dicts, each containing at minimum:
            ``type``, ``severity``, ``page``, ``description``,
            ``suggested_action``.
        """
        full_path = self._resolve_path(page_path)
        if not full_path.is_file():
            logger.warning("Page not found: %s", page_path)
            return []

        page_content = full_path.read_text(encoding="utf-8")
        relative_page = self._to_relative(full_path)

        # Load context files
        schema = self._read_file("schema.md")
        purpose = self._read_file("purpose.md")

        prompt = self._pm.render(
            "review-scan",
            page_path=relative_page,
            page_content=page_content,
            schema=schema,
            purpose=purpose,
        )

        logger.info("Sending review prompt to LLM (page=%s)", relative_page)

        try:
            response = self._llm.invoke(prompt)
            raw = response.content if hasattr(response, "content") else str(response)
        except Exception as exc:
            logger.error("LLM invoke failed during review scan: %s", exc)
            return []

        items = self._parse_review(raw)
        # Ensure the page field is set on each item
        for item in items:
            if "page" not in item or not item["page"]:
                item["page"] = relative_page
        return items

    def scan_all_pages(self) -> list[dict]:
        """Scan all wiki pages in the project and return review items.

        Walks ``wiki/`` recursively and scans each markdown file.
        Large wikis are scanned page-by-page to avoid exceeding the
        LLM context window.

        Returns
        -------
        list[dict]
            Aggregated list of review item dicts from all pages.
        """
        all_items: list[dict] = []
        wiki_dir = self._wiki_path / "wiki"
        if not wiki_dir.is_dir():
            logger.warning("Wiki directory not found: %s", wiki_dir)
            return []

        markdown_files = sorted(wiki_dir.rglob("*.md"))
        for md_file in markdown_files:
            relative = self._to_relative(md_file)
            items = self.scan_page(relative)
            all_items.extend(items)

        return all_items

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _resolve_path(self, page_path: str) -> Path:
        """Resolve a possibly-relative page path to an absolute path."""
        p = Path(page_path)
        if p.is_absolute():
            return p
        return (self._wiki_path / page_path).resolve()

    def _to_relative(self, full_path: Path) -> str:
        """Convert an absolute path to a POSIX-style relative path."""
        try:
            rel = full_path.relative_to(self._wiki_path)
        except ValueError:
            return str(full_path)
        return rel.as_posix()

    def _read_file(self, name: str) -> str:
        """Read a file from the wiki root, returning empty string on error."""
        path = self._wiki_path / name
        if path.is_file():
            return path.read_text(encoding="utf-8")
        return ""

    @staticmethod
    def _parse_review(raw: str) -> list[dict]:
        """Parse the LLM response into a list of review item dicts.

        Handles both bare JSON arrays and markdown-fenced `` ```json ... ``` ``.
        """
        # 1. Try to extract a fenced JSON block
        json_str = _extract_json_block(raw)
        if json_str is None:
            json_str = raw.strip()

        try:
            data = json.loads(json_str)
        except json.JSONDecodeError as exc:
            logger.warning("Failed to parse review JSON: %s", exc)
            logger.debug("Raw LLM output: %.500s", raw)
            return []

        # Support both {"review_items": [...]} and bare [...]
        if isinstance(data, dict):
            items = data.get("review_items", data.get("items", []))
        elif isinstance(data, list):
            items = data
        else:
            logger.warning("Unexpected review data type: %s", type(data).__name__)
            return []

        if not isinstance(items, list):
            logger.warning("review_items is not a list")
            return []

        # Validate each item has required fields
        valid_items = []
        required = {"type", "severity", "description", "suggested_action"}
        for item in items:
            if not isinstance(item, dict):
                continue
            # Ensure page field exists
            if "page" not in item or not item["page"]:
                continue
            if required.issubset(item.keys()):
                # Validate type against known values
                try:
                    ReviewItemType(item["type"])
                except ValueError:
                    continue
                valid_items.append(item)

        return valid_items


def _extract_json_block(text: str) -> str | None:
    """Extract JSON from a markdown fenced code block (`` ```json ... ``` ``).

    Returns ``None`` if no fenced JSON block is found.
    """
    m = re.search(
        r"```(?:json)\s*\n(.*?)\n```",
        text,
        re.DOTALL | re.IGNORECASE,
    )
    if m:
        return m.group(1).strip()

    m = re.search(r"```\s*\n(.*?)\n```", text, re.DOTALL)
    if m:
        return m.group(1).strip()

    return None
