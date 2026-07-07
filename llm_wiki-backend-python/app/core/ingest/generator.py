"""IngestGenerator — second step of the two-step ingestion pipeline.

Takes the structured analysis produced by :class:`IngestAnalyzer` and generates
Wiki pages (Markdown with YAML frontmatter), updating the index, overview, and
log files accordingly.
"""

import json
import logging
import re
from datetime import datetime
from typing import Any

import yaml
from langchain_core.language_models import BaseChatModel

from app.core.prompts.manager import PromptManager
from app.services.file_service import FileService

logger = logging.getLogger(__name__)


class IngestGenerator:
    """Generate Wiki pages from a structured analysis.

    The generator renders the ``ingest-generation`` prompt template, sends it
    to an LLM, parses the resulting multi-page Markdown output, writes pages
    to the project's ``wiki/`` directory, and updates the project's index and
    log files.
    """

    def __init__(
        self,
        llm: BaseChatModel,
        prompt_manager: PromptManager,
        file_service: FileService,
    ) -> None:
        """Initialise the generator.

        Parameters
        ----------
        llm : BaseChatModel
            LangChain chat model used for the generation step.
        prompt_manager : PromptManager
            Used to load and render the ``ingest-generation`` prompt template.
        file_service : FileService
            File service bound to the project root for writing generated files.
        """
        self._llm = llm
        self._pm = prompt_manager
        self._fs = file_service

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def generate(
        self,
        project_path: str,
        analysis: dict[str, Any],
        source_identity: str,
        project_context: dict[str, Any],
    ) -> list[str]:
        """Generate Wiki pages from the analysis.

        Parameters
        ----------
        project_path : str
            Project root path (used when the internal FileService needs to
            locate project files).
        analysis : dict
            Structured analysis from :class:`IngestAnalyzer` with keys
            ``key_entities``, ``key_concepts``, ``main_arguments``, etc.
        source_identity : str
            Source identity string (e.g. ``raw/sources/paper.pdf``).
        project_context : dict
            Project context dict with at least ``purpose``, ``schema``,
            ``index``, ``overview``, and ``language_directive`` keys.

        Returns
        -------
        list[str]
            List of file paths (relative to project root) that were written.
        """
        analysis_json = json.dumps(analysis, ensure_ascii=False, indent=2)

        try:
            prompt = self._pm.render(
                "ingest-generation",
                language_directive=project_context.get("language_directive", ""),
                purpose=project_context.get("purpose", ""),
                schema=project_context.get("schema", ""),
                index=project_context.get("index", ""),
                overview=project_context.get("overview", ""),
                analysis=analysis_json,
                source_identity=source_identity,
            )
        except Exception as exc:
            logger.error("Failed to render generation prompt: %s", exc)
            return []

        logger.info("Sending generation prompt to LLM (source=%s)", source_identity)

        try:
            response = self._llm.invoke(prompt)
            raw = response.content if hasattr(response, "content") else str(response)
        except Exception as exc:
            logger.error("LLM invoke failed during generation: %s", exc)
            return []

        pages = self._parse_pages(raw)
        if not pages:
            logger.warning("No pages parsed from LLM output (source=%s)", source_identity)
            return []

        written = self._write_pages(pages)
        self._update_index(pages)
        self._update_log(source_identity, pages)

        return written

    # ------------------------------------------------------------------
    # Page parsing
    # ------------------------------------------------------------------

    @staticmethod
    def _parse_pages(llm_output: str) -> list[dict[str, Any]]:
        """Parse the LLM output into a list of page dicts.

        The LLM is instructed to delimit each file with a fenced code block
        whose "language" tag is the file path:

        ```wiki/path/to/page.md
        ---
        type: entity
        title: Page Title
        ---
        Page content here...
        ```

        Returns a list of dicts with keys: ``path``, ``metadata``, ``body``,
        ``full_content``.
        """
        pages: list[dict[str, Any]] = []
        # Match fenced code blocks: ```path\ncontent\n```
        pattern = re.compile(
            r"```([^\n]+)\s*\n(.*?)```",
            re.DOTALL,
        )

        for match in pattern.finditer(llm_output):
            raw_path = match.group(1).strip()
            content = match.group(2).strip()

            if not raw_path or not content:
                continue

            # Parse YAML frontmatter if present
            metadata: dict[str, Any] = {}
            body = content
            if content.startswith("---"):
                parts = content.split("---", 2)
                if len(parts) >= 3:
                    yaml_str = parts[1].strip()
                    body = parts[2].strip()
                    if yaml_str:
                        try:
                            metadata = yaml.safe_load(yaml_str) or {}
                        except yaml.YAMLError as exc:
                            logger.warning(
                                "Failed to parse YAML frontmatter for %s: %s",
                                raw_path,
                                exc,
                            )
                            metadata = {}
                    # Ensure metadata is a dict (safe_load can return None)
                    if not isinstance(metadata, dict):
                        metadata = {}

            pages.append({
                "path": raw_path,
                "metadata": metadata,
                "body": body,
                "full_content": content,
            })

        return pages

    # ------------------------------------------------------------------
    # File writing
    # ------------------------------------------------------------------

    def _write_pages(self, pages: list[dict[str, Any]]) -> list[str]:
        """Write all parsed pages to disk via FileService.

        Returns a list of successfully written file paths.
        """
        written: list[str] = []
        for page in pages:
            try:
                self._fs.write_file(page["path"], page["full_content"])
                written.append(page["path"])
            except Exception as exc:
                logger.error("Failed to write page %s: %s", page["path"], exc)
        return written

    # ------------------------------------------------------------------
    # Index update
    # ------------------------------------------------------------------

    def _update_index(self, pages: list[dict[str, Any]]) -> None:
        """Update ``wiki/index.md`` with links to newly created pages.

        New pages are added under type-specific sections (Entities, Concepts,
        Sources, etc.).  Pages already present in the index are skipped.
        """
        index_path = "wiki/index.md"
        existing_links = self._read_existing_links(index_path)
        new_lines: list[str] = []

        for page in pages:
            page_type = page.get("metadata", {}).get("type", "page")
            title = page.get("metadata", {}).get("title") or self._title_from_path(page["path"])
            link = f"- [[{title}]]"

            if link.strip() in existing_links:
                continue

            section = self._type_to_section(page_type)
            new_lines.append(f"{section}|{link}")

        if not new_lines:
            return  # Nothing to add

        old_content = self._read_file_safe(index_path)
        new_content = self._merge_index_content(old_content, new_lines)
        self._write_file_safe(index_path, new_content)

    @staticmethod
    def _type_to_section(page_type: str) -> str:
        """Map a page type to its index section name."""
        mapping = {
            "entity": "Entities",
            "concept": "Concepts",
            "source": "Sources",
            "reference": "References",
            "note": "Notes",
            "experiment": "Experiments",
            "result": "Results",
            "literature": "Literature",
            "book": "Books",
            "article": "Articles",
            "goal": "Goals",
            "habit": "Habits",
            "reflection": "Reflections",
            "project": "Projects",
            "meeting": "Meetings",
            "competitor": "Competitors",
        }
        return mapping.get(page_type.lower(), "Pages")

    def _read_existing_links(self, index_path: str) -> set[str]:
        """Read all existing ``[[wikilink]]`` entries from the index file."""
        content = self._read_file_safe(index_path)
        links: set[str] = set()
        for line in content.splitlines():
            stripped = line.strip()
            if stripped.startswith("- [[") and stripped.endswith("]]"):
                links.add(stripped)
        return links

    @staticmethod
    def _merge_index_content(old_content: str, new_lines: list[str]) -> str:
        """Merge new page entries into the existing index content.

        If the index does not exist yet, create it from scratch.
        """
        if not old_content.strip():
            sections = {}
            for entry in new_lines:
                section, link = entry.split("|", 1)
                sections.setdefault(section, []).append(link)

            lines = ["# Wiki Index\n"]
            for section_name in sorted(sections.keys()):
                lines.append(f"\n## {section_name}\n")
                for link in sections[section_name]:
                    lines.append(f"{link}\n")
            return "".join(lines)

        # Insert new entries under their respective sections
        lines = old_content.splitlines(keepends=True)
        sections_found: set[str] = set()
        section_positions: dict[str, int] = {}
        for i, line in enumerate(lines):
            m = re.match(r"^##\s+(.+)$", line.strip())
            if m:
                sec = m.group(1).strip()
                sections_found.add(sec)
                if sec not in section_positions:
                    section_positions[sec] = i

        # Group new entries by section
        pending: dict[str, list[str]] = {}
        for entry in new_lines:
            section, link = entry.split("|", 1)
            pending.setdefault(section, []).append(link)

        for section, links in pending.items():
            if section in section_positions:
                # Insert after the section header
                pos = section_positions[section] + 1
                # Skip past any blank lines or existing items
                while pos < len(lines) and (
                    lines[pos].strip() == "" or lines[pos].strip().startswith("- [")
                ):
                    pos += 1
                for link in links:
                    lines.insert(pos, f"{link}\n")
                    pos += 1
            else:
                # Append new section at the end
                lines.append(f"\n## {section}\n")
                for link in links:
                    lines.append(f"{link}\n")

        return "".join(lines)

    # ------------------------------------------------------------------
    # Log update
    # ------------------------------------------------------------------

    def _update_log(self, source_identity: str, pages: list[dict[str, Any]]) -> None:
        """Append an entry to ``wiki/log.md`` recording the ingestion.

        The log entry includes a timestamp, the source identity, and a list
        of written pages.
        """
        log_path = "wiki/log.md"
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        page_lines = "\n".join(
            f"  - {p['path']}" for p in pages
        )
        entry = (
            f"\n## {timestamp}\n"
            f"- **Source**: {source_identity}\n"
            f"- **Pages**:\n{page_lines}\n"
        )

        old_content = self._read_file_safe(log_path)
        if old_content.strip():
            new_content = old_content.rstrip() + "\n" + entry
        else:
            new_content = "# Ingest Log\n" + entry

        self._write_file_safe(log_path, new_content)

    # ------------------------------------------------------------------
    # File I/O helpers
    # ------------------------------------------------------------------

    def _read_file_safe(self, path: str) -> str:
        """Read a file, returning an empty string if it does not exist."""
        try:
            return self._fs.read_file(path)
        except Exception:
            return ""

    def _write_file_safe(self, path: str, content: str) -> None:
        """Write a file, logging but not propagating errors."""
        try:
            self._fs.write_file(path, content)
        except Exception as exc:
            logger.error("Failed to write %s: %s", path, exc)

    # ------------------------------------------------------------------
    # Misc helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _title_from_path(path: str) -> str:
        """Derive a human-readable title from a file path."""
        stem = path.rsplit("/", 1)[-1] if "/" in path else path
        stem = stem.rsplit(".", 1)[0] if "." in stem else stem
        # Convert kebab/snake case to Title Case
        return stem.replace("-", " ").replace("_", " ").strip().title()
