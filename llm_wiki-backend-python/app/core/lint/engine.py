"""Lint engine for Wiki projects.

Provides structural (rule-based) and semantic (LLM-assisted) checking
of wiki pages.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any, Callable

import yaml

logger = logging.getLogger("llm-wiki")

# Regex for [[wikilinks]] — matches [[target]] or [[target|display text]]
WIKILINK_RE = re.compile(r"\[\[([^\]]+?)(?:\|([^\]]*))?\]\]")

# Regex for markdown links — [text](target)
MD_LINK_RE = re.compile(r"\[([^\]]*)\]\(([^)]+)\)")

# Expected log entry pattern: "- YYYY-MM-DD HH:MM: ..."
LOG_ENTRY_RE = re.compile(r"^- \d{4}-\d{2}-\d{2} \d{2}:\d{2}: .+", re.MULTILINE)

# Frontmatter delimiter
FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n?", re.DOTALL)

# Required frontmatter fields
REQUIRED_FRONTMATTER_FIELDS = {"type", "title"}


# ── Helper utilities ────────────────────────────────────────────────────────


def _parse_frontmatter(
    content: str,
) -> tuple[dict[str, Any] | None, str]:
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


def _find_wiki_pages(wiki_path: Path) -> list[Path]:
    """Return all ``.md`` files under *wiki_path* recursively."""
    if not wiki_path.is_dir():
        return []
    return sorted(p for p in wiki_path.rglob("*.md") if p.is_file())


def _resolve_wikilink_target(
    link_target: str, wiki_path: Path, known_pages: set[Path]
) -> Path | None:
    """Resolve a ``[[wikilink]]`` target to an existing file path.

    Tries several strategies:
    1. Exact relative path under ``wiki_path`` (with ``.md`` appended).
    2. Slug‑based match — the target as a file name anywhere under ``wiki_path``.
    3. Case‑insensitive fallback for both strategies.
    """
    # Strategy 1: exact relative path
    candidate = (wiki_path / link_target).with_suffix(".md")
    if candidate in known_pages or candidate.exists():
        return candidate.resolve()

    # Strategy 2: slug match — find by file stem
    target_stem = Path(link_target).stem.lower()
    for page in known_pages:
        if page.stem.lower() == target_stem:
            return page.resolve()

    # Strategy 3: case‑insensitive exact match
    for page in known_pages:
        rel = page.relative_to(wiki_path)
        if rel.with_suffix("").as_posix().lower() == link_target.lower().replace(
            "\\", "/"
        ):
            return page.resolve()

    return None


def _build_lint_item(
    lint_type: str,
    severity: str,
    file: str | Path,
    message: str,
    fix_suggestion: str | None = None,
) -> dict[str, Any]:
    """Build a standardised lint result dictionary."""
    return {
        "type": lint_type,
        "severity": severity,
        "file": str(file),
        "message": message,
        "fix_suggestion": fix_suggestion,
    }


# ── LintEngine ──────────────────────────────────────────────────────────────
# This feature was generated as per the plan requirements.

LINT_SEVERITY_VALUES = ("error", "warning", "info")


class LintEngine:
    """Lint engine for Wiki projects.

    Performs two categories of checks:

    * **Structural** (rule‑based, no LLM required)
        - YAML frontmatter presence & required fields
        - Broken ``[[wikilinks]]``
        - Invalid links in ``index.md``
        - Malformed ``log.md`` entries
    * **Semantic** (optionally LLM‑powered)
        - Content / type mismatches
        - Duplicate content detection
        - Orphan pages (no incoming links)
    """

    def __init__(self, wiki_path: Path, schema_path: Path) -> None:
        """Initialise the lint engine.

        Args:
            wiki_path: Path to the ``wiki/`` directory.
            schema_path: Path to the ``schema.md`` file (used for context).
        """
        self.wiki_path = wiki_path.resolve()
        self.schema_path = schema_path.resolve()
        self._pages: list[Path] = []
        self._page_map: dict[str, Path] = {}  # stem → path for quick lookup

    # ── Public API ──────────────────────────────────────────────────────────

    def run_all(self, llm_call: Callable | None = None) -> dict[str, list[dict]]:
        """Run all lint checks.

        Args:
            llm_call: Optional callable ``llm_call(prompt: str) -> str``
                used for semantic checks. When ``None``, semantic checks
                that require an LLM are skipped.

        Returns:
            A dictionary ``{"structural": [...], "semantic": [...]}``.
        """
        self._refresh_page_index()
        return {
            "structural": self.run_structural_checks(),
            "semantic": self.run_semantic_checks(llm_call=llm_call),
        }

    def run_structural_checks(self) -> list[dict]:
        """Run all structural (rule‑based) checks.

        Returns:
            A list of lint result dictionaries.
        """
        self._refresh_page_index()
        results: list[dict] = []

        for page in self._pages:
            results.extend(self._check_frontmatter(page))

        for page in self._pages:
            results.extend(self._check_wikilinks(page))

        # index.md specific checks
        index_page = self.wiki_path / "index.md"
        if index_page in self._pages:
            results.extend(self._check_index_links(index_page))

        # log.md specific checks
        log_page = self.wiki_path / "log.md"
        if log_page in self._pages:
            results.extend(self._check_log_format(log_page))

        return results

    def run_semantic_checks(
        self, llm_call: Callable | None = None
    ) -> list[dict]:
        """Run semantic checks.

        Args:
            llm_call: Optional callable for LLM‑powered checks.

        Returns:
            A list of lint result dictionaries.
        """
        self._refresh_page_index()
        results: list[dict] = []

        # Orphan check — pure rule, no LLM needed
        results.extend(self._check_orphans())

        # Content / type mismatch — requires LLM
        if llm_call is not None:
            results.extend(self._check_type_mismatch(llm_call))
            results.extend(self._check_duplicate_content(llm_call))

        return results

    # ── Internal: page index ───────────────────────────────────────────────

    def _refresh_page_index(self) -> None:
        """Rebuild the internal page list and slug map."""
        self._pages = _find_wiki_pages(self.wiki_path)
        self._page_map = {}
        for p in self._pages:
            stem = p.stem.lower()
            if stem not in self._page_map:
                self._page_map[stem] = p

    # ── Structural check implementations ────────────────────────────────────

    def _check_frontmatter(self, page: Path) -> list[dict]:
        """Check that *page* has valid YAML frontmatter with required fields."""
        results: list[dict] = []
        rel_path = page.relative_to(self.wiki_path.parent)

        content = self._read_file(page)
        if content is None:
            return results

        frontmatter, body = _parse_frontmatter(content)

        if frontmatter is None:
            results.append(
                _build_lint_item(
                    lint_type="missing_frontmatter",
                    severity="error",
                    file=rel_path,
                    message="Missing YAML frontmatter",
                    fix_suggestion="Add frontmatter delimiters '---' with type and title fields",
                )
            )
            return results

        # Check for empty/blank body after frontmatter
        if not body or not body.strip():
            results.append(
                _build_lint_item(
                    lint_type="empty_body",
                    severity="warning",
                    file=rel_path,
                    message="Page body is empty (no content after frontmatter)",
                    fix_suggestion="Add markdown content after the frontmatter block",
                )
            )

        # Check required fields
        missing = REQUIRED_FRONTMATTER_FIELDS - set(frontmatter.keys())
        for field in sorted(missing):
            results.append(
                _build_lint_item(
                    lint_type="missing_frontmatter_field",
                    severity="error",
                    file=rel_path,
                    message=f"Frontmatter missing required field '{field}'",
                    fix_suggestion=f"Add '{field}: <value>' to the frontmatter block",
                )
            )

        return results

    def _check_wikilinks(self, page: Path) -> list[dict]:
        """Check that all ``[[wikilinks]]`` on *page* point to existing files."""
        results: list[dict] = []
        rel_path = page.relative_to(self.wiki_path.parent)

        content = self._read_file(page)
        if content is None:
            return results

        known_pages_set = set(self._pages)

        for match in WIKILINK_RE.finditer(content):
            target = match.group(1).strip()
            if not target:
                continue

            resolved = _resolve_wikilink_target(target, self.wiki_path, known_pages_set)
            if resolved is None:
                results.append(
                    _build_lint_item(
                        lint_type="broken_wikilink",
                        severity="warning",
                        file=rel_path,
                        message=f"Broken [[wikilink]]: '{target}' does not match any page",
                        fix_suggestion=f"Create a page for '{target}' or fix the link",
                    )
                )

        return results

    def _check_index_links(self, index_page: Path) -> list[dict]:
        """Check that links in ``index.md`` point to existing pages."""
        results: list[dict] = []
        rel_path = index_page.relative_to(self.wiki_path.parent)

        content = self._read_file(index_page)
        if content is None:
            return results

        known_pages_set = set(self._pages)

        # Check markdown links [text](target)
        for match in MD_LINK_RE.finditer(content):
            target = match.group(2).strip()
            if not target or target.startswith(("http://", "https://", "#")):
                continue

            candidate = (self.wiki_path / target).resolve()
            if not candidate.exists() and candidate not in known_pages_set:
                results.append(
                    _build_lint_item(
                        lint_type="broken_index_link",
                        severity="warning",
                        file=rel_path,
                        message=f"Broken index link: '{target}' does not exist",
                        fix_suggestion=f"Update or remove the link to '{target}'",
                    )
                )

        # Also check wikilinks in index.md
        results.extend(self._check_wikilinks(index_page))

        return results

    def _check_log_format(self, log_page: Path) -> list[dict]:
        """Check that ``log.md`` entries follow the expected format.

        Expected format::

            - 2024-01-15 14:30: Operation description
        """
        results: list[dict] = []
        rel_path = log_page.relative_to(self.wiki_path.parent)

        content = self._read_file(log_page)
        if content is None:
            return results

        # Skip the first line if it's a heading like "# Log" or "## Changelog"
        lines = content.strip().split("\n")
        non_heading_lines = [
            l for l in lines if not l.strip().startswith("#")
        ]

        if not non_heading_lines:
            return results

        for i, line in enumerate(non_heading_lines, start=1):
            stripped = line.strip()
            if not stripped:
                continue
            # Each entry should start with "- " followed by a timestamp
            if not LOG_ENTRY_RE.match(stripped):
                results.append(
                    _build_lint_item(
                        lint_type="malformed_log_entry",
                        severity="warning",
                        file=rel_path,
                        message=(
                            f"Line {i} in log.md does not follow expected format: "
                            f"'{{stripped[:60]}}'"
                        ),
                        fix_suggestion=(
                            "Expected format: '- YYYY-MM-DD HH:MM: Description'"
                        ),
                    )
                )

        return results

    # ── Semantic check implementations ──────────────────────────────────────

    def _check_orphans(self) -> list[dict]:
        """Detect orphan pages — pages with no incoming ``[[wikilinks]]``.

        A page is considered orphaned when no other page in the wiki links
        to it.
        """
        results: list[dict] = []

        # Build incoming link index
        incoming: dict[Path, int] = {p: 0 for p in self._pages}

        for page in self._pages:
            content = self._read_file(page)
            if content is None:
                continue
            for match in WIKILINK_RE.finditer(content):
                target = match.group(1).strip()
                resolved = _resolve_wikilink_target(
                    target, self.wiki_path, set(self._pages)
                )
                if resolved is not None:
                    # Find the original page path matching this resolved path
                    for p in self._pages:
                        if p.resolve() == resolved:
                            incoming[p] = incoming.get(p, 0) + 1
                            break

        # index.md and log.md are expected to be central navigation pages;
        # they are not considered orphans.
        exempt = {self.wiki_path / "index.md", self.wiki_path / "log.md"}

        for page, count in incoming.items():
            if count == 0 and page not in exempt:
                rel_path = page.relative_to(self.wiki_path.parent)
                results.append(
                    _build_lint_item(
                        lint_type="orphan_page",
                        severity="info",
                        file=rel_path,
                        message=(
                            f"Orphan page: no incoming [[wikilinks]] from other pages"
                        ),
                        fix_suggestion="Add [[wikilinks]] to this page from related pages",
                    )
                )

        return results

    def _check_type_mismatch(
        self, llm_call: Callable[[str], str]
    ) -> list[dict]:
        """Use LLM to check if page content matches its declared type.

        Requires a callable that accepts a prompt and returns LLM text.
        """
        results: list[dict] = []

        for page in self._pages:
            content = self._read_file(page)
            if content is None:
                continue

            frontmatter, body = _parse_frontmatter(content)
            if frontmatter is None:
                continue

            page_type = frontmatter.get("type", "unknown")
            if not body or not body.strip():
                continue

            prompt = (
                f"You are a Wiki linting assistant. Check if the following page "
                f"content matches its declared type '{page_type}'.\n\n"
                f"If the content does NOT match the type, respond with a short "
                f"explanation of why. If it DOES match, respond with just 'OK'.\n"
                f"--- Content ---\n{body[:2000]}"
            )
            verdict = llm_call(prompt)
            verdict_stripped = verdict.strip()

            if verdict_stripped and verdict_stripped != "OK":
                rel_path = page.relative_to(self.wiki_path.parent)
                results.append(
                    _build_lint_item(
                        lint_type="type_mismatch",
                        severity="warning",
                        file=rel_path,
                        message=f"Content may not match declared type '{page_type}': {verdict_stripped[:200]}",
                        fix_suggestion="Update the 'type' field in frontmatter or revise content",
                    )
                )

        return results

    def _check_duplicate_content(
        self, llm_call: Callable[[str], str]
    ) -> list[dict]:
        """Use LLM to detect near‑duplicate pages."""
        results: list[dict] = []

        # Compare pages in pairs (only bodies, skip if too similar structurally)
        bodies: list[tuple[Path, str]] = []
        for page in self._pages:
            content = self._read_file(page)
            if content is None:
                continue
            _, body = _parse_frontmatter(content)
            if body and body.strip():
                bodies.append((page, body.strip()))

        for i in range(len(bodies)):
            for j in range(i + 1, len(bodies)):
                page_a, body_a = bodies[i]
                page_b, body_b = bodies[j]

                # Quick heuristic: if bodies are identical (trimmed), flag immediately
                if body_a == body_b:
                    rel_a = page_a.relative_to(self.wiki_path.parent)
                    rel_b = page_b.relative_to(self.wiki_path.parent)
                    results.append(
                        _build_lint_item(
                            lint_type="duplicate_content",
                            severity="warning",
                            file=rel_a,
                            message=f"Exact duplicate content with {rel_b}",
                            fix_suggestion="Consolidate or remove the duplicate page",
                        )
                    )
                    continue

                # For near‑duplicates, ask the LLM
                prompt = (
                    f"Are the following two wiki pages about the SAME topic or "
                    f"containing DUPLICATE information? Answer YES or NO "
                    f"followed by a brief explanation.\n\n"
                    f"--- Page A ---\n{body_a[:1500]}\n\n"
                    f"--- Page B ---\n{body_b[:1500]}"
                )
                verdict = llm_call(prompt)
                if verdict.strip().upper().startswith("YES"):
                    rel_a = page_a.relative_to(self.wiki_path.parent)
                    rel_b = page_b.relative_to(self.wiki_path.parent)
                    results.append(
                        _build_lint_item(
                            lint_type="duplicate_content",
                            severity="warning",
                            file=rel_a,
                            message=f"Possibly duplicate content with {rel_b}",
                            fix_suggestion="Consider consolidating these pages",
                        )
                    )

        return results

    # ── File I/O helpers ────────────────────────────────────────────────────

    @staticmethod
    def _read_file(path: Path) -> str | None:
        """Read a text file, returning ``None`` on error."""
        try:
            return path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            logger.warning("Cannot read %s: %s", path, exc)
            return None
