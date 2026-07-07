"""Deduplication detection and page merging for Wiki projects.

Uses ``difflib.SequenceMatcher`` to compare page titles and detect
near‑duplicate pages. The :class:`DedupDetector` also provides a
:meth:`merge_pages` operation that consolidates two pages into one,
merging frontmatter fields (``sources``, ``tags``, ``aliases``) and
updating all ``[[wikilinks]]`` across the wiki.
"""

from __future__ import annotations

import difflib
import logging
import re
from pathlib import Path
from typing import Any

import yaml

logger = logging.getLogger("llm-wiki")

WIKILINK_RE = re.compile(r"\[\[([^\]]+?)(?:\|([^\]]*))?\]\]")
FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n?", re.DOTALL)


# ── Helper utilities ────────────────────────────────────────────────────────


def _parse_frontmatter(content: str) -> tuple[dict[str, Any] | None, str]:
    """Parse YAML frontmatter from markdown content.

    Args:
        content: Full text content of a markdown file.

    Returns:
        A tuple ``(frontmatter_dict, body)`` where *frontmatter_dict* is
        ``None`` when no valid frontmatter is found.
    """
    match = FRONTMATTER_RE.match(content)
    if not match:
        return None, content

    yaml_text = match.group(1)
    body = content[match.end() :]

    try:
        frontmatter = yaml.safe_load(yaml_text)
        if not isinstance(frontmatter, dict):
            return None, body
        return frontmatter, body
    except yaml.YAMLError:
        return None, body


def _merge_frontmatter_fields(
    keep: dict[str, Any], merge_from: dict[str, Any]
) -> dict[str, Any]:
    """Merge frontmatter fields from *merge_from* into *keep*.

    List‑typed fields (``sources``, ``tags``, ``aliases``) are deduplicated
    while preserving order. Scalar values from *merge_from* are converted to
    lists first. All other fields from *keep* are preserved as‑is.
    """
    merged = dict(keep)
    list_fields = {"sources", "tags", "aliases"}

    for field in list_fields:
        if field not in merge_from:
            continue
        existing = merged.get(field, [])
        if isinstance(existing, str):
            existing = [existing]
        incoming = merge_from[field]
        if isinstance(incoming, str):
            incoming = [incoming]
        elif not isinstance(incoming, list):
            continue
        combined = list(dict.fromkeys(list(existing) + list(incoming)))
        if combined:
            merged[field] = combined

    return merged


# ── DedupDetector ───────────────────────────────────────────────────────────


class DedupDetector:
    """Detect near‑duplicate wiki pages by title similarity and merge them.

    Args:
        wiki_path: Root path of the ``wiki/`` directory.
    """

    def __init__(self, wiki_path: Path) -> None:
        self.wiki_path = wiki_path.resolve()

    # ── Public API ──────────────────────────────────────────────────────────

    def find_duplicates(self, threshold: float = 0.7) -> list[dict[str, Any]]:
        """Scan all wiki pages and detect near‑duplicates by title similarity.

        Args:
            threshold: Minimum similarity ratio (0.0–1.0). Only pairs at or
                above this threshold are reported.

        Returns:
            A list of dicts sorted by descending similarity, each containing:
            ``page_a``, ``page_b``, ``similarity``, and ``suggestion``.
        """
        pages = self._get_all_pages()
        results: list[dict[str, Any]] = []

        for i in range(len(pages)):
            for j in range(i + 1, len(pages)):
                a, b = pages[i], pages[j]
                ratio = difflib.SequenceMatcher(
                    None, a["title"].lower(), b["title"].lower()
                ).ratio()
                if ratio >= threshold:
                    results.append(
                        {
                            "page_a": a["page_id"],
                            "page_b": b["page_id"],
                            "similarity": round(ratio, 4),
                            "suggestion": (
                                f"Consider merging '{a['title']}' and "
                                f"'{b['title']}' (similarity: {ratio:.1%})"
                            ),
                        }
                    )

        return sorted(results, key=lambda x: x["similarity"], reverse=True)

    def merge_pages(self, page_a: str, page_b: str) -> dict[str, Any]:
        """Merge two pages into one, keeping the more complete version.

        The page with the longer body is preserved; the other page's
        frontmatter fields (``sources``, ``tags``, ``aliases``) are merged
        into the kept page. All ``[[wikilinks]]`` across the wiki that
        reference the deleted page are updated to point to the kept page.

        Args:
            page_a: Identifier of the first page (relative path without
                ``.md``, e.g. ``"entities/foo"``).
            page_b: Identifier of the second page.

        Returns:
            A dict with ``merged_page``, ``deleted_page``, and ``changes``.

        Raises:
            ValueError: If either page identifier does not exist.
        """
        pages = {p["page_id"]: p for p in self._get_all_pages()}

        if page_a not in pages:
            raise ValueError(f"Page '{page_a}' not found in wiki")
        if page_b not in pages:
            raise ValueError(f"Page '{page_b}' not found in wiki")

        a_data = pages[page_a]
        b_data = pages[page_b]

        # Keep the page with the longer body (more complete)
        if len(a_data["body"]) >= len(b_data["body"]):
            keep = dict(a_data)
            merged_from = dict(b_data)
        else:
            keep = dict(b_data)
            merged_from = dict(a_data)

        # Merge frontmatter fields
        merged_fm = _merge_frontmatter_fields(
            keep["frontmatter"], merged_from["frontmatter"]
        )

        # Write merged page
        new_yaml = yaml.safe_dump(merged_fm, allow_unicode=True, sort_keys=False).strip()
        merged_content = f"---\n{new_yaml}\n---\n\n{keep['body'].strip()}\n"
        keep["path"].write_text(merged_content, encoding="utf-8")

        # Update [[wikilinks]] across all wiki pages
        wikilink_updates: list[dict[str, str]] = []
        deleted_id = merged_from["page_id"]
        kept_id = keep["page_id"]

        for p in self.wiki_path.rglob("*.md"):
            old_text = p.read_text(encoding="utf-8")

            def _make_replacer(target_id: str, new_id: str, updates: list) -> Any:
                def _replace(m: re.Match) -> str:
                    target = m.group(1).strip()
                    display = m.group(2)
                    if target == target_id:
                        updates.append(
                            {
                                "file": str(p.relative_to(self.wiki_path)),
                                "old_link": target,
                                "new_link": new_id,
                            }
                        )
                        if display:
                            return f"[[{new_id}|{display}]]"
                        return f"[[{new_id}]]"
                    return m.group(0)

                return _replace

            replacer = _make_replacer(deleted_id, kept_id, wikilink_updates)
            new_text = WIKILINK_RE.sub(replacer, old_text)
            if new_text != old_text:
                p.write_text(new_text, encoding="utf-8")

        # Delete the merged‑away page file
        deleted_path = merged_from["path"]
        if deleted_path.exists():
            deleted_path.unlink()

        return {
            "merged_page": kept_id,
            "deleted_page": deleted_id,
            "changes": {"wikilink_updates": wikilink_updates},
        }

    # ── Internal helpers ────────────────────────────────────────────────────

    def _get_all_pages(self) -> list[dict[str, Any]]:
        """Return metadata for all ``.md`` files under *wiki_path*."""
        pages: list[dict[str, Any]] = []
        for p in sorted(self.wiki_path.rglob("*.md")):
            if not p.is_file():
                continue
            content = p.read_text(encoding="utf-8")
            frontmatter, body = _parse_frontmatter(content)
            rel = p.relative_to(self.wiki_path)
            page_id = rel.with_suffix("").as_posix()
            pages.append(
                {
                    "path": p,
                    "page_id": page_id,
                    "title": frontmatter.get("title", p.stem) if frontmatter else p.stem,
                    "frontmatter": frontmatter or {},
                    "body": body,
                    "content": content,
                }
            )
        return pages
