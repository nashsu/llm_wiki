"""IngestPipeline — orchestrator for the two-step ingestion pipeline.

Coordinates the analysis and generation steps, loading the necessary project
context before delegating to :class:`IngestAnalyzer` and
:class:`IngestGenerator`.
"""

import logging
from datetime import datetime
from pathlib import Path
from typing import Any

from app.core.ingest.analyzer import IngestAnalyzer
from app.core.ingest.generator import IngestGenerator
from app.core.ingest.source_identity import get_source_identity
from app.parsers import parse_document

logger = logging.getLogger(__name__)


class IngestPipeline:
    """Orchestrate the two-step ingestion pipeline.

    Usage::

        pipeline = IngestPipeline(analyzer, generator)
        result = pipeline.run(source_path="/path/to/doc.pdf",
                               project_path="/path/to/project")
    """

    def __init__(
        self,
        analyzer: IngestAnalyzer,
        generator: IngestGenerator,
    ) -> None:
        """Initialise the pipeline.

        Parameters
        ----------
        analyzer : IngestAnalyzer
            The analysis step.
        generator : IngestGenerator
            The generation step.
        """
        self._analyzer = analyzer
        self._generator = generator

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def run(
        self,
        source_path: str,
        project_path: str,
    ) -> dict[str, Any]:
        """Run the full ingestion pipeline for a single source file.

        Parameters
        ----------
        source_path : str
            Absolute or project-relative path to the source file to ingest.
        project_path : str
            Absolute path to the project root.

        Returns
        -------
        dict
            A dictionary with keys:
            - ``source_path`` — the original source file path
            - ``project_path`` — the project root path
            - ``source_identity`` — the resolved source identity
            - ``analysis`` — the structured analysis dict
            - ``pages_written`` — list of file paths written
            - ``log_entry`` — dict with ``timestamp`` and ``source`` fields
        """
        # 1. Parse the source file
        parsed = parse_document(source_path)
        source_content = parsed.text
        if not parsed.success:
            logger.warning(
                "Source parsing reported failure: %s (source=%s)",
                parsed.error,
                source_path,
            )

        # 2. Derive the source identity
        source_identity = get_source_identity(source_path, project_path)

        # 3. Load project context
        project_context = self._load_project_context(project_path)

        # 4. Run analysis
        logger.info("Starting analysis step (source=%s)", source_identity)
        analysis = self._analyzer.analyze(
            source_path=source_path,
            source_content=source_content,
            project_context=project_context,
        )

        # 5. Run generation
        logger.info("Starting generation step (source=%s)", source_identity)
        pages_written = self._generator.generate(
            project_path=project_path,
            analysis=analysis,
            source_identity=source_identity,
            project_context=project_context,
        )

        # 6. Build result
        timestamp = datetime.now().isoformat()
        log_entry = {
            "timestamp": timestamp,
            "source": source_identity,
            "pages": pages_written,
        }

        return {
            "source_path": source_path,
            "project_path": project_path,
            "source_identity": source_identity,
            "analysis": analysis,
            "pages_written": pages_written,
            "log_entry": log_entry,
        }

    # ------------------------------------------------------------------
    # Project context loading
    # ------------------------------------------------------------------

    @staticmethod
    def _load_project_context(project_path: str) -> dict[str, Any]:
        """Load the project's context files from disk.

        Reads:
        - ``{project_path}/purpose.md`` → key ``purpose``
        - ``{project_path}/schema.md`` → key ``schema``
        - ``{project_path}/wiki/index.md`` → key ``index``
        - ``{project_path}/wiki/overview.md`` → key ``overview``

        Missing files produce empty strings.
        """
        base = Path(project_path)

        context: dict[str, Any] = {
            "purpose": _read_file_safe(base / "purpose.md"),
            "schema": _read_file_safe(base / "schema.md"),
            "index": _read_file_safe(base / "wiki" / "index.md"),
            "overview": _read_file_safe(base / "wiki" / "overview.md"),
            "language_directive": "",
        }

        # Set a sensible default language directive if purpose is in Chinese
        purpose = context["purpose"]
        if purpose and any("\u4e00" <= ch <= "\u9fff" for ch in purpose[:200]):
            context["language_directive"] = "\u8bf7\u7528\u4e2d\u6587\u56de\u590d\u3002"
        else:
            context["language_directive"] = "Please respond in English."

        return context


def _read_file_safe(path: Path) -> str:
    """Read a text file, returning an empty string if it does not exist."""
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return ""
    except Exception as exc:
        logger.warning("Failed to read %s: %s", path, exc)
        return ""
