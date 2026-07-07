"""IngestAnalyzer — first step of the two-step ingestion pipeline.

Reads a source document and produces a structured analysis (entities, concepts,
arguments, connections, contradictions, recommendations) that the
:class:`~app.core.ingest.generator.IngestGenerator` later turns into Wiki pages.
"""

import json
import logging
import re
from typing import Any

from langchain_core.language_models import BaseChatModel

from app.core.ingest.source_identity import get_source_identity
from app.core.prompts.manager import PromptManager

logger = logging.getLogger(__name__)

_ANALYSIS_FIELDS = [
    "key_entities",
    "key_concepts",
    "main_arguments",
    "connections",
    "contradictions",
    "recommendations",
]

_DEFAULT_ANALYSIS: dict[str, list] = {field: [] for field in _ANALYSIS_FIELDS}


class IngestAnalyzer:
    """Analyse a source document and produce a structured analysis dict.

    The analysis is produced by sending the source content together with the
    project's purpose, schema, and current index to an LLM, and parsing the
    structured JSON response.
    """

    def __init__(
        self,
        llm: BaseChatModel,
        prompt_manager: PromptManager,
    ) -> None:
        """Initialise the analyzer.

        Parameters
        ----------
        llm : BaseChatModel
            LangChain chat model used for the analysis step.
        prompt_manager : PromptManager
            Used to load and render the ``ingest-analysis`` prompt template.
        """
        self._llm = llm
        self._pm = prompt_manager

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def analyze(
        self,
        source_path: str,
        source_content: str,
        project_context: dict[str, Any],
    ) -> dict[str, Any]:
        """Analyse a source document and return a structured analysis dict.

        The method renders the ``ingest-analysis`` prompt template, sends it
        to the LLM, and parses the result as JSON.

        Parameters
        ----------
        source_path : str
            Path to the source file (used to derive the source identity).
        source_content : str
            Text content of the source document.
        project_context : dict
            Must contain at least ``purpose``, ``schema``, ``index``, and
            ``language_directive`` keys.  Optionally ``project_path`` for
            identity resolution.

        Returns
        -------
        dict
            A dictionary with keys: ``key_entities``, ``key_concepts``,
            ``main_arguments``, ``connections``, ``contradictions``,
            ``recommendations``.  Each value is a list of dicts or strings.
            If parsing fails, all fields are empty lists.
        """
        project_path = project_context.get("project_path", "")
        source_identity = get_source_identity(source_path, project_path)

        prompt = self._pm.render(
            "ingest-analysis",
            language_directive=project_context.get("language_directive", ""),
            purpose=project_context.get("purpose", ""),
            schema=project_context.get("schema", ""),
            index=project_context.get("index", ""),
            source_identity=source_identity,
            source_content=source_content,
        )

        logger.info("Sending analysis prompt to LLM (source=%s)", source_identity)

        try:
            response = self._llm.invoke(prompt)
            raw = response.content if hasattr(response, "content") else str(response)
        except Exception as exc:
            logger.error("LLM invoke failed during analysis: %s", exc)
            return dict(_DEFAULT_ANALYSIS)

        return self._parse_analysis(raw)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _parse_analysis(raw: str) -> dict[str, Any]:
        """Parse the LLM response into a structured analysis dict.

        Handles both bare JSON and markdown-fenced `` ```json ... ``` `` output.
        """
        # 1. Try to extract a fenced JSON block
        json_str = _extract_json_block(raw)
        if json_str is None:
            # 2. Fall back to treating the whole output as JSON
            json_str = raw.strip()

        try:
            data = json.loads(json_str)
        except json.JSONDecodeError as exc:
            logger.warning("Failed to parse analysis JSON: %s", exc)
            logger.debug("Raw LLM output: %.500s", raw)
            return dict(_DEFAULT_ANALYSIS)

        if not isinstance(data, dict):
            logger.warning("Analysis result is not a dict (type=%s)", type(data).__name__)
            return dict(_DEFAULT_ANALYSIS)

        # Ensure all expected fields exist (fill missing with empty lists)
        result: dict[str, Any] = {}
        for field in _ANALYSIS_FIELDS:
            value = data.get(field, [])
            if not isinstance(value, list):
                value = [value]
            result[field] = value
        return result


def _extract_json_block(text: str) -> str | None:
    """Extract JSON from a markdown fenced code block (`` ```json ... ``` ``).

    Returns ``None`` if no fenced JSON block is found.
    """
    # Match ```json ... ``` (case-insensitive)
    m = re.search(
        r"```(?:json)\s*\n(.*?)\n```",
        text,
        re.DOTALL | re.IGNORECASE,
    )
    if m:
        return m.group(1).strip()

    # Fallback: match any ``` ... ``` block and try to parse as JSON later
    m = re.search(r"```\s*\n(.*?)\n```", text, re.DOTALL)
    if m:
        return m.group(1).strip()

    return None
