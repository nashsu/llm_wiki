"""WikiLink enrichment and repair for Wiki projects.

The :class:`WikiLinkEnricher` detects terms in page bodies that should be
linked (matching titles of other wiki pages but not yet wrapped in
``[[wikilinks]]``), automatically adds them, and can also find and fix
broken ``[[wikilinks]]`` that point to non‑existent pages.
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
    """Parse YAML frontmatter from markdown content."""
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


def _get_wikilink_spans(text: str) -> list[tuple[int, int]]:
    """Return ``(start, end)`` positions of all ``[[wikilinks]]`` in *text*."""
    spans: list[tuple[int, int]] = []
    for m in WIKILINK_RE.finditer(text):
        spans.append((m.start(), m.end()))
    return spans


def _is_inside_wikilink(pos: int, spans: list[tuple[int, int]]) -> bool:
    """Check whether character position *pos* falls inside any wikilink span."""
    return any(start <= pos < end for start, end in spans)


def _compute_fuzzy_similarity(a: str, b: str) -> float:
    """Normalized similarity between two strings (0.0–1.0)."""
    return difflib.SequenceMatcher(None, a.lower(), b.lower()).ratio()


def _normalize_id(s: str) -> str:
    """Lowercase a string and strip separators for loose matching.

    Removes underscores, hyphens, spaces, and forward slashes so that
    ``ExistingPage``, ``existing_page``, and ``existing/page`` all
    normalize to the same key.
    """
    return s.lower().replace("_", "").replace("-", "").replace(" ", "").replace("/", "")


# ── WikiLinkEnricher ────────────────────────────────────────────────────────


class WikiLinkEnricher:
    """Detect and auto‑add missing ``[[wikilinks]]``, and fix broken ones.

    Args:
        wiki_path: Root path of the ``wiki/`` directory.
    """

    def __init__(self, wiki_path: Path) -> None:
        self.wiki_path = wiki_path.resolve()

    # ── Public API ──────────────────────────────────────────────────────────

    def get_all_page_titles(self) -> list[str]:
        """Return the display titles of all wiki pages.

        Titles are extracted from the ``title`` field of YAML frontmatter.
        Pages without frontmatter use their filename stem as the title.
        """
        titles: list[str] = []
        for p in sorted(self.wiki_path.rglob("*.md")):
            if not p.is_file():
                continue
            content = p.read_text(encoding="utf-8")
            frontmatter, _body = _parse_frontmatter(content)
            if frontmatter and "title" in frontmatter:
                titles.append(frontmatter["title"])
            else:
                titles.append(p.stem)
        return titles

    def _get_all_page_identifiers(self) -> dict[str, str]:
        """Build a mapping of all valid page identifiers → page ID.

        Returns a dict (lowercase_key → canonical_page_id) that includes:
        - the relative path without ``.md`` (e.g. ``entities/foo``)
        - the filename stem (e.g. ``foo``)
        - the frontmatter title (e.g. ``Foo Bar``)
        """
        result: dict[str, str] = {}
        for p in sorted(self.wiki_path.rglob("*.md")):
            if not p.is_file():
                continue
            rel = p.relative_to(self.wiki_path)
            page_id = rel.with_suffix("").as_posix()
            result[page_id.lower()] = page_id
            result[p.stem.lower()] = page_id
            content = p.read_text(encoding="utf-8")
            frontmatter, _body = _parse_frontmatter(content)
            if frontmatter and "title" in frontmatter:
                result[frontmatter["title"].lower()] = page_id
        return result

    def find_missing_links(self, page_path: str) -> list[str]:
        """Find terms in a page body that should be linked via ``[[wikilinks]]``.

        Scans the content area (skipping YAML frontmatter) of the page at
        *page_path* (relative to ``wiki_path``, without ``.md``) and
        identifies titles of other wiki pages that appear in the text but
        are not yet wrapped in ``[[ ]]``.

        Matching is case‑insensitive.

        Args:
            page_path: Relative path of the page (e.g. ``"entities/foo"``).

        Returns:
            A list of term strings (page titles) that should be linked.
        """
        full_path = (self.wiki_path / page_path).with_suffix(".md")
        if not full_path.exists():
            return []

        content = full_path.read_text(encoding="utf-8")
        _frontmatter, body = _parse_frontmatter(content)
        if not body or not body.strip():
            return []

        all_titles = self.get_all_page_titles()
        # Get this page's own title to avoid self‑links
        own_title = (
            _frontmatter["title"]
            if _frontmatter and "title" in _frontmatter
            else full_path.stem
        )

        wikilink_spans = _get_wikilink_spans(body)

        # Sort titles by length descending to match longer phrases first
        titles_to_check = sorted(
            [t for t in all_titles if t.lower() != own_title.lower()],
            key=len,
            reverse=True,
        )

        missing: list[str] = []
        seen_positions: set[int] = set()

        for title in titles_to_check:
            if not title or len(title) < 2:
                continue
            escaped = re.escape(title)
            for m in re.finditer(escaped, body, re.IGNORECASE):
                pos = m.start()
                if pos in seen_positions:
                    continue
                if _is_inside_wikilink(pos, wikilink_spans):
                    continue
                if _is_inside_wikilink(pos + len(title) - 1, wikilink_spans):
                    continue
                missing.append(title)
                seen_positions.add(pos)
                break  # one link per title per page

        return missing

    def auto_enrich(self, page_path: str) -> list[str]:
        """Automatically add ``[[wikilinks]]`` for missing terms in a page.

        Only the content area (after YAML frontmatter) is processed. For
        each missing term, the first non‑linked occurrence is wrapped in
        ``[[ ]]``. Matching is case‑insensitive but the wikilink target
        uses the canonical title from the target page's frontmatter.

        Args:
            page_path: Relative path of the page (e.g. ``"entities/foo"``).

        Returns:
            A list of link terms that were added.
        """
        full_path = (self.wiki_path / page_path).with_suffix(".md")
        if not full_path.exists():
            return []

        content = full_path.read_text(encoding="utf-8")
        _frontmatter, body = _parse_frontmatter(content)
        if not body or not body.strip():
            return []

        missing = self.find_missing_links(page_path)
        if not missing:
            return []

        # Sort missing terms by length descending so longer phrases are
        # replaced first (avoids partial overlap issues)
        missing_sorted = sorted(missing, key=len, reverse=True)
        added: list[str] = []

        # Operate on the body string progressively — each replacement is
        # applied to the running string, and subsequent searches are on the
        # updated text so coordinate math stays correct.
        for title in missing_sorted:
            wikilink_spans = _get_wikilink_spans(body)
            escaped = re.escape(title)
            for m in re.finditer(escaped, body, re.IGNORECASE):
                pos = m.start()
                matched_text = m.group()  # the actual matched text (preserves case from body)
                if _is_inside_wikilink(pos, wikilink_spans):
                    continue
                if _is_inside_wikilink(pos + len(matched_text) - 1, wikilink_spans):
                    continue
                # Replace this occurrence with [[title]]
                body = body[:pos] + f"[[{title}]]" + body[pos + len(matched_text):]
                added.append(title)
                break

        # Reconstruct full content with frontmatter preserved
        fm_end_match = FRONTMATTER_RE.match(content)
        if fm_end_match:
            fm_end = fm_end_match.end()
        else:
            fm_end = 0

        new_content = content[:fm_end] + "\n" + body
        full_path.write_text(new_content, encoding="utf-8")

        return added

    def batch_enrich(self) -> dict[str, list[str]]:
        """Run :meth:`auto_enrich` on every wiki page.

        Returns:
            A dict mapping page relative paths to the list of links added.
        """
        results: dict[str, list[str]] = {}
        for p in sorted(self.wiki_path.rglob("*.md")):
            if not p.is_file():
                continue
            rel = p.relative_to(self.wiki_path)
            page_id = rel.with_suffix("").as_posix()
            added = self.auto_enrich(page_id)
            if added:
                results[page_id] = added
        return results

    def fix_broken_links(self) -> list[dict[str, Any]]:
        """Find and repair broken ``[[wikilinks]]`` across the wiki.

        Scans all pages for ``[[wikilinks]]`` whose targets do not
        correspond to any existing page file (by path, stem, or frontmatter
        title). For each broken link, a fuzzy‑match attempt is made against
        known page identifiers. If a close match (similarity ≥ 0.7) is
        found, a fix suggestion with the corrected target is generated.

        Returns:
            A list of fix reports, each containing ``page`` (the file
            containing the broken link), ``broken_target``, ``fix_suggestion``,
            and optionally ``auto_fixed_target`` if a match was found.
        """
        # Build a comprehensive set of known identifiers
        # Map: (normalized_key, original_key) → (canonical_page_id, stem)
        known: dict[str, tuple[str, str]] = {}  # norm_key → (page_id, stem)
        raw_keys: list[str] = []  # also keep raw keys for exact match
        for p in self.wiki_path.rglob("*.md"):
            if not p.is_file():
                continue
            rel = p.relative_to(self.wiki_path)
            page_id = rel.with_suffix("").as_posix()
            stem = p.stem
            for raw_key in (page_id, stem):
                known[_normalize_id(raw_key)] = (page_id, stem)
                raw_keys.append(raw_key)
            content = p.read_text(encoding="utf-8")
            frontmatter, _body = _parse_frontmatter(content)
            if frontmatter and "title" in frontmatter:
                title = frontmatter["title"]
                known[_normalize_id(title)] = (page_id, stem)
                raw_keys.append(title)

        reports: list[dict[str, Any]] = []

        for p in sorted(self.wiki_path.rglob("*.md")):
            if not p.is_file():
                continue
            content = p.read_text(encoding="utf-8")
            rel = p.relative_to(self.wiki_path)

            for m in WIKILINK_RE.finditer(content):
                target = m.group(1).strip()
                if not target:
                    continue

                # First check raw keys (exact, case‑insensitive)
                if target.lower() in {k.lower() for k in raw_keys}:
                    continue  # link is valid

                # Then check normalized keys
                norm_target = _normalize_id(target)
                if norm_target in known:
                    continue  # link is valid after normalization

                # Try fuzzy match against stems and page IDs
                best_match: str | None = None
                best_ratio = 0.0
                for norm_key, (pid, stem) in known.items():
                    r1 = _compute_fuzzy_similarity(target, pid)
                    r2 = _compute_fuzzy_similarity(target, stem)
                    ratio = max(r1, r2)
                    if ratio > best_ratio:
                        best_ratio = ratio
                        best_match = pid

                report: dict[str, Any] = {
                    "page": rel.as_posix(),
                    "broken_target": target,
                    "fix_suggestion": f"Broken link to '{target}'",
                }

                if best_match and best_ratio >= 0.7:
                    report["auto_fixed_target"] = best_match
                    report["fix_suggestion"] = (
                        f"Replace [[{target}]] with [[{best_match}]] "
                        f"(similarity: {best_ratio:.0%})"
                    )

                reports.append(report)

        return reports
