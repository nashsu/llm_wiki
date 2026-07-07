"""Clip (web clipping) service.

Handles receiving, listing, and deleting web clippings saved as
Markdown files with YAML frontmatter under the project's
``raw/clips/`` directory.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger("llm-wiki")


class ClipServiceError(Exception):
    """Base exception for clip service errors."""


class ClipNotFound(ClipServiceError):
    """Raised when a clip cannot be found."""


class ClipService:
    """Manages web clippings stored as Markdown files.

    Clips are saved to ``{project_path}/raw/clips/`` with YAML frontmatter.
    """

    def __init__(self) -> None:
        self._lock = False  # reserved for future thread-safe usage

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def receive_clip(
        self,
        project_path: str,
        content: str,
        url: str,
        title: str,
    ) -> dict:
        """Save a web clipping as a Markdown file.

        Args:
            project_path: Absolute path to the LLM Wiki project.
            content:      Markdown content of the clipped page.
            url:          Original URL of the clipped page.
            title:        Page title used to generate the filename.

        Returns:
            Dict with keys ``file_path``, ``title``, ``url``.
        """
        clips_dir = self._ensure_clips_dir(project_path)
        filename = self._generate_filename(clips_dir, title)
        file_path = clips_dir / filename

        frontmatter = self._build_frontmatter(url, title)
        md_content = f"{frontmatter}\n\n{content.strip()}\n"
        file_path.write_text(md_content, encoding="utf-8")

        logger.info("Clip saved: %s <- %s", filename, url)
        return {
            "file_path": str(file_path.resolve()),
            "title": title,
            "url": url,
        }

    def list_clips(self, project_path: str) -> list[dict]:
        """List all saved clippings in a project.

        Each entry contains ``id`` (filename stem), ``title``, ``url``,
        ``clipped_at``, and ``file_path``.
        """
        clips_dir = Path(project_path, "raw", "clips")
        if not clips_dir.is_dir():
            return []

        clips: list[dict] = []
        for md_file in sorted(clips_dir.iterdir()):
            if md_file.suffix.lower() != ".md":
                continue
            meta = self._parse_clip_meta(md_file)
            if meta is not None:
                clips.append(meta)
        return clips

    def delete_clip(self, project_path: str, clip_id: str) -> None:
        """Delete a clipping by its ID (filename without extension).

        Raises:
            ClipNotFound: If no clipping with *clip_id* exists.
        """
        clips_dir = Path(project_path, "raw", "clips")
        target = clips_dir / f"{clip_id}.md"
        if not target.is_file():
            raise ClipNotFound(f"Clip not found: {clip_id}")
        target.unlink()
        logger.info("Clip deleted: %s", clip_id)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _ensure_clips_dir(project_path: str) -> Path:
        """Create ``raw/clips/`` under *project_path* if missing."""
        clips_dir = Path(project_path, "raw", "clips")
        clips_dir.mkdir(parents=True, exist_ok=True)
        return clips_dir

    @staticmethod
    def _generate_filename(clips_dir: Path, title: str) -> Path:
        """Generate a unique filename from *title* and current timestamp.

        The title is sanitised to a safe filename fragment, then combined
        with an ISO-like timestamp.
        """
        safe = re.sub(r"[^\w\s-]", "", title, flags=re.UNICODE)
        safe = re.sub(r"[-\s]+", "_", safe.strip(), flags=re.UNICODE)
        safe = safe[:80] or "untitled"

        ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        filename = f"{safe}_{ts}.md"

        # Avoid collisions by appending a counter
        counter = 1
        while (clips_dir / filename).exists():
            filename = f"{safe}_{ts}_{counter}.md"
            counter += 1

        return clips_dir / filename

    @staticmethod
    def _build_frontmatter(url: str, title: str) -> str:
        """Build YAML frontmatter string for a clip."""
        now = datetime.now(timezone.utc).isoformat()
        return (
            "---\n"
            f"type: clip\n"
            f"url: {url}\n"
            f"title: {title}\n"
            f"clipped_at: {now}\n"
            "---"
        )

    @staticmethod
    def _parse_clip_meta(file_path: Path) -> dict | None:
        """Parse YAML frontmatter from a clip Markdown file.

        Returns a dict with keys ``id``, ``title``, ``url``,
        ``clipped_at``, ``file_path``, or ``None`` on failure.
        """
        try:
            text = file_path.read_text(encoding="utf-8")
        except Exception:
            logger.exception("Failed to read clip: %s", file_path)
            return None

        frontmatter = _extract_frontmatter(text)
        if frontmatter is None:
            return None

        return {
            "id": file_path.stem,
            "title": frontmatter.get("title", file_path.stem),
            "url": frontmatter.get("url", ""),
            "clipped_at": frontmatter.get("clipped_at", ""),
            "file_path": str(file_path.resolve()),
        }


def _extract_frontmatter(text: str) -> dict | None:
    """Extract YAML frontmatter between ``---`` delimiters.

    This is a simple line-based parser that handles basic key: value pairs.
    Returns a dict or ``None`` if frontmatter is not found.
    """
    lines = text.split("\n")
    if not lines or lines[0].strip() != "---":
        return None

    end = -1
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end = i
            break

    if end == -1:
        return None

    meta: dict[str, str] = {}
    for line in lines[1:end]:
        line = line.strip()
        if not line or ":" not in line:
            continue
        key, _, value = line.partition(":")
        meta[key.strip()] = value.strip()

    return meta
