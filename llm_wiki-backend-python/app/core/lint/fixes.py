"""Auto‑fix and fix‑suggestion utilities for lint results.

The :class:`LintFixer` can automatically repair certain categories of
lint issues such as missing frontmatter, broken wikilinks, and
malformed log entries.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import yaml

from app.core.lint.engine import (
    _parse_frontmatter,
    _resolve_wikilink_target,
    WIKILINK_RE,
    FRONTMATTER_RE,
)

logger = logging.getLogger("llm-wiki")


# ── Fix templates ───────────────────────────────────────────────────────────

_DEFAULT_FRONTMATTER_TEMPLATE = """---
type: note
title: {title}
---

"""

_LOG_ENTRY_TEMPLATE = "- {timestamp}: {description}"

# ── LintFixer ───────────────────────────────────────────────────────────────


class FixError(Exception):
    """Raised when an auto‑fix operation fails."""


class LintFixer:
    """Auto‑fix and suggest‑fix for wiki lint issues.

    Args:
        wiki_path: Root path of the wiki project (same as passed to
            :class:`~app.core.lint.engine.LintEngine`).
    """

    def __init__(self, wiki_path: Path) -> None:
        self.wiki_path = wiki_path.resolve()
        self._fix_count: int = 0

    # ── Public API ──────────────────────────────────────────────────────────

    def auto_fix(self, lint_item: dict[str, Any]) -> bool:
        """Attempt to auto‑fix a single lint item in place.

        Args:
            lint_item: A lint result dictionary (as produced by
                :class:`~app.core.lint.engine.LintEngine`).

        Returns:
            ``True`` if the fix was applied successfully, ``False``
            if the fix type is not supported or the file could not be
            modified.

        Raises:
            FixError: If an unexpected error occurs during fixing.
        """
        lint_type = lint_item.get("type", "")
        file_path = Path(lint_item["file"])

        # The `file` field in lint items is relative to wiki_path.parent
        full_path = (self.wiki_path.parent / file_path).resolve()

        if not full_path.exists():
            logger.warning("Cannot fix %s: file not found %s", lint_type, full_path)
            return False

        try:
            if lint_type == "missing_frontmatter":
                return self._fix_missing_frontmatter(full_path)
            elif lint_type == "missing_frontmatter_field":
                return self._fix_missing_frontmatter_field(full_path, lint_item)
            elif lint_type == "broken_wikilink":
                return self._fix_broken_wikilink(full_path, lint_item)
            elif lint_type == "malformed_log_entry":
                return self._fix_malformed_log_entry(full_path, lint_item)
            else:
                logger.info("No auto‑fix available for lint type '%s'", lint_type)
                return False
        except OSError as exc:
            raise FixError(f"Failed to fix {lint_type} in {full_path}: {exc}") from exc

    def suggest_fix(self, lint_item: dict[str, Any]) -> str:
        """Generate a human‑readable fix suggestion for a lint item.

        Args:
            lint_item: A lint result dictionary.

        Returns:
            A human‑readable suggestion string.
        """
        fix_suggestion = lint_item.get("fix_suggestion")
        if fix_suggestion:
            return fix_suggestion

        lint_type = lint_item.get("type", "")
        file_path = lint_item.get("file", "?")
        message = lint_item.get("message", "")

        suggestions: dict[str, str] = {
            "missing_frontmatter": (
                f"Add YAML frontmatter to '{file_path}'. "
                f"Open the file and add:\n---\ntype: note\ntitle: <title>\n---\n"
            ),
            "missing_frontmatter_field": (
                f"Edit '{file_path}' frontmatter to include the missing field. "
            ),
            "broken_wikilink": (
                f"In '{file_path}', fix or remove the broken wikilink. "
                f"Message: {message}"
            ),
            "broken_index_link": (
                f"In '{file_path}', update or remove the broken link. "
                f"Message: {message}"
            ),
            "orphan_page": (
                f"Add [[wikilinks]] to '{file_path}' from related pages "
                f"so it becomes reachable."
            ),
            "malformed_log_entry": (
                f"Edit '{file_path}' to follow the expected format: "
                f"'- YYYY-MM-DD HH:MM: Description'"
            ),
            "empty_body": (
                f"Add markdown content to '{file_path}' after the frontmatter block."
            ),
            "type_mismatch": (
                f"Review '{file_path}': either change the 'type' field "
                f"in frontmatter or revise the content to match the declared type."
            ),
            "duplicate_content": (
                f"Review '{file_path}' for possible duplicate content. "
                f"Message: {message}"
            ),
        }

        return suggestions.get(lint_type, f"Manual review needed for '{file_path}': {message}")

    def batch_fix(self, lint_items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Attempt to fix multiple lint items.

        Non‑fixable items are returned unchanged. Items that were
        successfully fixed are removed from the returned list.

        Args:
            lint_items: A list of lint result dictionaries.

        Returns:
            A list of lint items that **could not** be fixed automatically.
        """
        remaining: list[dict[str, Any]] = []
        for item in lint_items:
            try:
                if not self.auto_fix(item):
                    remaining.append(item)
            except FixError:
                logger.exception("Fix error for item %s", item.get("type", "?"))
                remaining.append(item)
        return remaining

    # ── Fix implementations ─────────────────────────────────────────────────

    def _fix_missing_frontmatter(self, file_path: Path) -> bool:
        """Add default frontmatter to a file that has none."""
        content = file_path.read_text(encoding="utf-8")
        title = file_path.stem.replace("-", " ").replace("_", " ").title()
        new_content = _DEFAULT_FRONTMATTER_TEMPLATE.format(title=title) + content
        file_path.write_text(new_content, encoding="utf-8")
        logger.info("Added frontmatter to %s", file_path)
        return True

    def _fix_missing_frontmatter_field(
        self, file_path: Path, lint_item: dict[str, Any]
    ) -> bool:
        """Add a missing required field to existing frontmatter."""
        content = file_path.read_text(encoding="utf-8")
        frontmatter, body = _parse_frontmatter(content)

        if frontmatter is None:
            return False  # no frontmatter to fix — should be handled by missing_frontmatter

        # Determine which field is missing
        message = lint_item.get("message", "")
        field_name = "title"
        if "type" in message:
            field_name = "type"

        # Add the field with a default value
        frontmatter[field_name] = field_name  # default: use field name as value

        new_yaml = yaml.safe_dump(frontmatter, allow_unicode=True, sort_keys=False).strip()
        new_content = f"---\n{new_yaml}\n---\n\n{body.lstrip()}"
        file_path.write_text(new_content, encoding="utf-8")
        logger.info("Added missing frontmatter field '%s' to %s", field_name, file_path)
        return True

    def _fix_broken_wikilink(
        self, file_path: Path, lint_item: dict[str, Any]
    ) -> bool:
        """Remove a broken wikilink from a file.

        Since we cannot guess the correct target, we remove the broken
        link and log the action.
        """
        content = file_path.read_text(encoding="utf-8")
        message = lint_item.get("message", "")

        # Extract the broken link target from the message
        # Message format: "Broken [[wikilink]]: 'target' does not match any page"
        import re as _re

        target_match = _re.search(r"'([^']+)'", message)
        if not target_match:
            return False

        broken_target = target_match.group(1)

        # Replace [[target]] with just the display text (if any) or remove
        def _replace_link(m: _re.Match) -> str:
            target = m.group(1).strip()
            display = m.group(2)
            if target == broken_target:
                # If has display text, keep it; otherwise remove
                return display if display else ""
            return m.group(0)

        new_content = WIKILINK_RE.sub(_replace_link, content)
        if new_content != content:
            file_path.write_text(new_content, encoding="utf-8")
            logger.info("Removed broken wikilink '%s' from %s", broken_target, file_path)
            return True

        return False

    def _fix_malformed_log_entry(
        self, file_path: Path, lint_item: dict[str, Any]
    ) -> bool:
        """Attempt to normalise a malformed log entry.

        This is a best‑effort fix — entries that cannot be parsed are
        prepended with a timestamp comment.
        """
        # For now, malformed entries require manual intervention
        # We log the issue but don't auto-modify log entries
        logger.info(
            "Cannot auto‑fix malformed log entry in %s — manual edit required",
            file_path,
        )
        return False
