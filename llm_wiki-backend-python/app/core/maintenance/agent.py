"""Maintenance Agent --- LangChain agent with file operations and safety flow.

The ``MaintenanceAgent`` uses ``create_agent`` (LangGraph-based) with
a custom system prompt from the ``maintenance-agent`` template and a set
of project-management tools.  It exposes a three-phase safety workflow:

1. **investigate** — read-only analysis, returns a structured plan.
2. **preview** — dry-run the plan, returns a diff.
3. **execute** — create a Git snapshot, then apply the plan (requires
   explicit ``confirmed=True``).
"""

from __future__ import annotations

import difflib
import json
import re
from pathlib import Path
from typing import Any

from jinja2 import Template
from langchain.agents import create_agent
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.tools import BaseTool, tool

from app.core.prompts.manager import PromptManager

# ---------------------------------------------------------------------------
# Tool factory functions
# ---------------------------------------------------------------------------

# Names of tools considered safe for the investigation phase.
_READ_ONLY_TOOL_NAMES = frozenset({
    "read_file",
    "list_directory",
    "search_wiki",
    "preview_changes",
})


def create_read_file_tool(project_path: str) -> BaseTool:
    """Create a tool that reads any file inside the project."""
    root = Path(project_path).resolve()

    @tool
    def read_file(path: str) -> str:
        """Read the full content of a file inside the project.

        Use this tool when you need to examine the content of a file.
        Provide a path relative to the project root, e.g. ``wiki/entities/python.md``.
        """
        full_path = (root / path).resolve()
        if not str(full_path).startswith(str(root)):
            return f"Error: Path '{path}' is outside the project directory."
        if not full_path.exists():
            return f"Error: File not found at '{path}'."
        if not full_path.is_file():
            return f"Error: '{path}' is not a file."
        try:
            return full_path.read_text(encoding="utf-8")
        except Exception as e:
            return f"Error reading file: {e}"

    return read_file


def create_write_file_tool(project_path: str) -> BaseTool:
    """Create a tool that writes content to a file (needs confirmation)."""
    root = Path(project_path).resolve()

    @tool
    def write_file(path: str, content: str, confirmed: bool = False) -> str:
        """Write content to a file inside the project.

        Set ``confirmed=True`` to actually perform the write.
        When ``confirmed`` is ``False`` (the default), a preview message
        is returned instead.
        """
        full_path = (root / path).resolve()
        if not str(full_path).startswith(str(root)):
            return f"Error: Path '{path}' is outside the project directory."

        if not confirmed:
            return (
                f"PREVIEW: Would write {len(content)} bytes to '{path}'.\n"
                f"--- preview content (first 500 chars) ---\n{content[:500]}"
            )

        try:
            full_path.parent.mkdir(parents=True, exist_ok=True)
            full_path.write_text(content, encoding="utf-8")
            return f"Successfully wrote {len(content)} bytes to '{path}'."
        except Exception as e:
            return f"Error writing file: {e}"

    return write_file


def create_list_directory_tool(project_path: str) -> BaseTool:
    """Create a tool that lists directory contents."""
    root = Path(project_path).resolve()

    @tool
    def list_directory(path: str = "") -> str:
        """List files and subdirectories inside the project.

        Provide a relative path (e.g. ``wiki``, ``raw/sources``).
        Leave empty to list the project root.
        """
        target = root / path if path else root
        full_path = target.resolve()
        if not str(full_path).startswith(str(root)):
            return f"Error: Path '{path}' is outside the project directory."
        if not full_path.exists():
            return f"Error: Directory not found at '{path}'."
        if not full_path.is_dir():
            return f"Error: '{path}' is not a directory."

        entries = sorted(
            full_path.iterdir(),
            key=lambda x: (not x.is_dir(), x.name.lower()),
        )
        lines = [f"Contents of /{path}:"]
        for entry in entries:
            suffix = "/" if entry.is_dir() else ""
            lines.append(f"  {entry.name}{suffix}")
        return "\n".join(lines)

    return list_directory


def create_delete_file_tool(project_path: str) -> BaseTool:
    """Create a tool that deletes a file (needs confirmation)."""
    root = Path(project_path).resolve()

    @tool
    def delete_file(path: str, confirmed: bool = False) -> str:
        """Delete a file inside the project.

        Set ``confirmed=True`` to actually delete.
        When ``confirmed`` is ``False``, only a preview is returned.
        """
        full_path = (root / path).resolve()
        if not str(full_path).startswith(str(root)):
            return f"Error: Path '{path}' is outside the project directory."
        if not full_path.exists():
            return f"Error: File not found at '{path}'."

        if not confirmed:
            return f"PREVIEW: Would delete file '{path}'."

        try:
            full_path.unlink()
            return f"Successfully deleted '{path}'."
        except Exception as e:
            return f"Error deleting file: {e}"

    return delete_file


def create_rename_file_tool(project_path: str) -> BaseTool:
    """Create a tool that renames a file (needs confirmation)."""
    root = Path(project_path).resolve()

    @tool
    def rename_file(old_path: str, new_path: str, confirmed: bool = False) -> str:
        """Rename or move a file inside the project.

        Set ``confirmed=True`` to actually rename.
        When ``confirmed`` is ``False``, only a preview is returned.
        """
        old_full = (root / old_path).resolve()
        new_full = (root / new_path).resolve()

        if not str(old_full).startswith(str(root)):
            return f"Error: Path '{old_path}' is outside the project directory."
        if not str(new_full).startswith(str(root)):
            return f"Error: Path '{new_path}' is outside the project directory."
        if not old_full.exists():
            return f"Error: File not found at '{old_path}'."

        if not confirmed:
            return f"PREVIEW: Would rename '{old_path}' -> '{new_path}'."

        try:
            new_full.parent.mkdir(parents=True, exist_ok=True)
            old_full.rename(new_full)
            return f"Successfully renamed '{old_path}' -> '{new_path}'."
        except Exception as e:
            return f"Error renaming file: {e}"

    return rename_file


def create_batch_update_frontmatter_tool(project_path: str) -> BaseTool:
    """Create a tool that batch-updates YAML frontmatter fields.

    Supports dry-run via the ``dry_run`` parameter (default ``True``).
    """
    root = Path(project_path).resolve()

    @tool
    def batch_update_frontmatter(
        pattern: str,
        updates: dict[str, str],
        dry_run: bool = True,
    ) -> str:
        """Batch update YAML frontmatter fields in Wiki pages.

        Args:
            pattern: Glob pattern relative to project root, e.g. ``wiki/**/*.md``.
            updates: Dict of frontmatter keys to new values (e.g. ``{"status": "stale"}``).
            dry_run: If ``True`` (default), show what would change without modifying.
        """
        matching = sorted(root.glob(pattern))
        if not matching:
            return f"No files matched pattern: {pattern}"

        results: list[str] = []
        for file_path in matching:
            if not file_path.is_file():
                continue
            rel = file_path.relative_to(root).as_posix()
            try:
                content = file_path.read_text(encoding="utf-8")
            except Exception as e:
                results.append(f"  {rel}: ERROR reading - {e}")
                continue

            updated = _update_frontmatter(content, updates)
            if updated == content:
                results.append(f"  {rel}: no changes needed")
                continue

            results.append(f"  {rel}: would update frontmatter")
            if not dry_run:
                file_path.write_text(updated, encoding="utf-8")
                results[-1] = f"  {rel}: frontmatter updated"

        prefix = "DRY-RUN: " if dry_run else ""
        lines = [f"{prefix}Processed {len(matching)} file(s) for pattern '{pattern}':"]
        lines.extend(results)
        return "\n".join(lines)

    return batch_update_frontmatter


def _update_frontmatter(content: str, updates: dict[str, str]) -> str:
    """Update YAML frontmatter fields in a Markdown file.

    Returns the updated content, or the original if no frontmatter found.
    """
    # Match frontmatter between --- delimiters
    m = re.match(r"^---\s*\n(.*?)\n---", content, re.DOTALL)
    if not m:
        return content

    fm_block = m.group(1)
    lines = fm_block.split("\n")
    updated_keys = set()

    new_lines: list[str] = []
    for line in lines:
        # Check if this line is a key we want to update
        for key, value in updates.items():
            if re.match(rf"^{re.escape(key)}\s*:", line):
                # Preserve indentation
                indent = re.match(r"^(\s*)", line).group(1)
                new_lines.append(f"{indent}{key}: {value}")
                updated_keys.add(key)
                break
        else:
            new_lines.append(line)

    # Add any keys that were not already present
    for key, value in updates.items():
        if key not in updated_keys:
            new_lines.append(f"{key}: {value}")

    new_fm = "\n".join(new_lines)
    return content[: m.start()] + f"---\n{new_fm}\n---" + content[m.end():]


def create_batch_replace_text_tool(project_path: str) -> BaseTool:
    """Create a tool that batch-replaces text across multiple files."""
    root = Path(project_path).resolve()

    @tool
    def batch_replace_text(
        pattern: str,
        old_text: str,
        new_text: str,
        dry_run: bool = True,
    ) -> str:
        """Search and replace text in files matching a glob pattern.

        Args:
            pattern: Glob pattern relative to project root, e.g. ``wiki/**/*.md``.
            old_text: The text to search for.
            new_text: The replacement text.
            dry_run: If ``True`` (default), show what would change.
        """
        matching = sorted(root.glob(pattern))
        if not matching:
            return f"No files matched pattern: {pattern}"

        results: list[str] = []
        total_replacements = 0
        for file_path in matching:
            if not file_path.is_file():
                continue
            rel = file_path.relative_to(root).as_posix()
            try:
                content = file_path.read_text(encoding="utf-8")
            except Exception as e:
                results.append(f"  {rel}: ERROR reading - {e}")
                continue

            if old_text not in content:
                continue

            count = content.count(old_text)
            total_replacements += count
            results.append(f"  {rel}: {count} replacement(s)")

            if not dry_run:
                new_content = content.replace(old_text, new_text)
                file_path.write_text(new_content, encoding="utf-8")

        prefix = "DRY-RUN: " if dry_run else ""
        lines = [
            f"{prefix}Processed {len(matching)} file(s) for pattern '{pattern}': "
            f"{total_replacements} total replacement(s) found."
        ]
        lines.extend(results)
        return "\n".join(lines)

    return batch_replace_text


def create_search_wiki_tool(search_engine: Any | None = None) -> BaseTool:
    """Create a tool that searches Wiki content."""
    has_engine = search_engine is not None and hasattr(search_engine, "search")

    @tool
    def search_wiki(query: str) -> str:
        """Search the Wiki for pages matching the given query.

        Use this tool to find information in the Wiki.
        Returns a formatted list of matching pages.
        """
        if not has_engine:
            return (
                "Search engine is not available. "
                "Try using list_directory and read_file tools instead."
            )
        try:
            results = search_engine.search(query)
            if not results:
                return f"No results found for: {query}"

            lines = [f"Found {len(results)} result(s):"]
            for i, r in enumerate(results[:10], 1):
                path = r.get("path", "unknown")
                snippet = (r.get("snippet") or r.get("content", ""))[:200]
                lines.append(f"{i}. {path}")
                if snippet:
                    lines.append(f"   {snippet}")
            return "\n".join(lines)
        except Exception as e:
            return f"Error searching Wiki: {e}"

    return search_wiki


def create_preview_changes_tool() -> BaseTool:
    """Create a tool that previews pending changes as a diff."""

    @tool
    def preview_changes(changes: list[dict] | None = None) -> str:
        """Preview changes as a unified diff.

        Provide a list of change dicts with keys ``action``, ``path``,
        and optionally ``old_content`` and ``new_content``.
        If no changes are provided, returns a placeholder message.
        """
        if not changes:
            return "No pending changes to preview."

        parts: list[str] = []
        for i, change in enumerate(changes):
            action = change.get("action", "unknown")
            path = change.get("path", "?")
            old = change.get("old_content", "")
            new = change.get("new_content", "")

            if old or new:
                diff = difflib.unified_diff(
                    old.splitlines(keepends=True),
                    new.splitlines(keepends=True),
                    fromfile=f"a/{path}",
                    tofile=f"b/{path}",
                )
                diff_text = "".join(diff)
                parts.append(f"Change #{i + 1}: {action} on {path}\n{diff_text}")
            else:
                parts.append(f"Change #{i + 1}: {action} on {path}")

        return "\n---\n".join(parts)

    return preview_changes


def create_snapshot_tool(version_control: Any | None = None) -> BaseTool:
    """Create a tool that creates a Git snapshot of the project."""

    @tool
    def create_snapshot(name: str = "auto-snapshot") -> str:
        """Create a Git snapshot (commit) of the current project state.

        Use this tool BEFORE making any destructive or批量 changes
        so you can roll back if needed.
        """
        if version_control is None:
            return (
                "Version control is not configured. "
                "Snapshot cannot be created."
            )
        try:
            result = version_control.create_snapshot(name)
            return f"Snapshot created: {result}"
        except Exception as e:
            return f"Error creating snapshot: {e}"

    return create_snapshot


# ---------------------------------------------------------------------------
# Action type dispatch table
# ---------------------------------------------------------------------------

_PLAN_ACTION_HANDLERS: dict[str, tuple[str, list[str], list[str]]] = {
    "read_file": ("read_file", ["path"], []),
    "write_file": ("write_file", ["path", "content"], ["confirmed"]),
    "delete_file": ("delete_file", ["path"], ["confirmed"]),
    "rename_file": ("rename_file", ["old_path", "new_path"], ["confirmed"]),
    "batch_update_frontmatter": (
        "batch_update_frontmatter",
        ["pattern", "updates"],
        ["dry_run"],
    ),
    "batch_replace_text": (
        "batch_replace_text",
        ["pattern", "old_text", "new_text"],
        ["dry_run"],
    ),
}


def _build_action_kwargs(action: dict, dry_run: bool) -> dict:
    """Build keyword arguments for a tool invocation from an action dict.

    Handles the mapping between action types and tool parameters,
    automatically setting confirmation/dry-run flags.
    """
    action_type = action.get("type", "")
    handler = _PLAN_ACTION_HANDLERS.get(action_type)
    if handler is None:
        raise ValueError(f"Unknown action type: {action_type}")

    tool_name, required_params, flag_params = handler

    kwargs: dict = {}
    for param in required_params:
        if param not in action:
            raise ValueError(
                f"Action '{action_type}' missing required parameter: {param}"
            )
        kwargs[param] = action[param]

    # Set confirmation / dry-run flags
    for flag in flag_params:
        if flag == "confirmed":
            kwargs[flag] = not dry_run
        elif flag == "dry_run":
            kwargs[flag] = dry_run

    return kwargs


# ---------------------------------------------------------------------------
# MaintenanceAgent
# ---------------------------------------------------------------------------


class MaintenanceAgent:
    """LangChain-powered automatic maintenance agent for the LLM Wiki.

    Implements a three-phase safety workflow:

    Phase 1 - **investigate**
        Read-only exploration of the project.  The LLM analyses the
        current state and returns a structured maintenance plan.

    Phase 2 - **preview**
        Dry-run of the plan.  All write operations are simulated and
        a diff is returned.

    Phase 3 - **execute**
        Actual execution.  A Git snapshot is created automatically
        before any changes are applied.  Requires ``confirmed=True``.

    Parameters
    ----------
    llm:
        A LangChain ``BaseChatModel`` instance.
    project_path:
        Absolute filesystem path to the Wiki project.
    prompt_manager:
        A ``PromptManager`` instance for loading templates.
    search_engine:
        Optional search engine.  If ``None``, the search tool returns a
        fallback message.
    version_control:
        Optional ``VersionControl`` instance.  If ``None``, snapshots
        are disabled.
    """

    def __init__(
        self,
        llm: BaseChatModel,
        project_path: str,
        prompt_manager: PromptManager,
        search_engine: Any | None = None,
        version_control: Any | None = None,
    ) -> None:
        self._llm = llm
        self._project_path = Path(project_path).resolve()
        self._prompt_manager = prompt_manager
        self._search_engine = search_engine
        self._version_control = version_control

        # Create tool instances (stored individually for direct invocation)
        self._read_file_tool = create_read_file_tool(project_path)
        self._write_file_tool = create_write_file_tool(project_path)
        self._list_directory_tool = create_list_directory_tool(project_path)
        self._delete_file_tool = create_delete_file_tool(project_path)
        self._rename_file_tool = create_rename_file_tool(project_path)
        self._batch_update_frontmatter_tool = create_batch_update_frontmatter_tool(
            project_path
        )
        self._batch_replace_text_tool = create_batch_replace_text_tool(project_path)
        self._search_wiki_tool = create_search_wiki_tool(search_engine)
        self._preview_changes_tool = create_preview_changes_tool()
        self._snapshot_tool = create_snapshot_tool(version_control)

        # All tools (for the agent)
        self.tools: list[BaseTool] = [
            self._read_file_tool,
            self._write_file_tool,
            self._list_directory_tool,
            self._delete_file_tool,
            self._rename_file_tool,
            self._batch_update_frontmatter_tool,
            self._batch_replace_text_tool,
            self._search_wiki_tool,
            self._preview_changes_tool,
            self._snapshot_tool,
        ]

        # Build system prompt from the maintenance-agent template
        system_prompt = self._build_system_prompt()

        # Create the LangGraph agent
        self.agent = create_agent(
            llm,
            tools=self.tools,
            system_prompt=system_prompt,
            interrupt_before=[],
            interrupt_after=[],
        )

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _build_system_prompt(self) -> str:
        """Assemble the system prompt from the maintenance-agent template."""
        template_text = self._prompt_manager.load("maintenance-agent")

        # Tool descriptions
        tool_lines = []
        for tool_ in self.tools:
            tool_lines.append(f"- ``{tool_.name}``: {tool_.description}")
        tool_descriptions = "\n".join(tool_lines)

        # Read schema.md if it exists
        schema_path = self._project_path / "schema.md"
        schema_text = (
            schema_path.read_text(encoding="utf-8")
            if schema_path.is_file()
            else "(No schema.md found)"
        )

        return Template(template_text).render(
            tool_descriptions=tool_descriptions,
            project_path=str(self._project_path),
            schema=schema_text,
        )

    @staticmethod
    def _parse_plan_from_response(response_text: str) -> dict | None:
        """Extract a JSON plan from the agent's response text.

        Tries to find a JSON block delimited by ``{`` ... ``}`` or
        `` ```json `` ... `` ``` ``.  Returns ``None`` if parsing fails.
        """
        # Try ```json ... ``` block first
        json_match = re.search(
            r"```(?:json)?\s*(\{.*?\})\s*```", response_text, re.DOTALL
        )
        if json_match:
            try:
                return json.loads(json_match.group(1))
            except json.JSONDecodeError:
                pass

        # Try bare { ... }
        brace_match = re.search(r"(\{.*\})", response_text, re.DOTALL)
        if brace_match:
            try:
                return json.loads(brace_match.group(1))
            except json.JSONDecodeError:
                pass

        return None

    @staticmethod
    def _generate_diff(
        old_content: str, new_content: str, path: str
    ) -> str:
        """Generate a unified diff string for a single file change."""
        diff = difflib.unified_diff(
            old_content.splitlines(keepends=True),
            new_content.splitlines(keepends=True),
            fromfile=f"a/{path}",
            tofile=f"b/{path}",
        )
        return "".join(diff)

    # ------------------------------------------------------------------
    # Three-phase safety flow
    # ------------------------------------------------------------------

    def investigate(self, request: str) -> dict:
        """Phase 1 — read-only investigation.

        The agent analyses the project using only read-only tools and
        returns a structured maintenance plan.

        Parameters
        ----------
        request:
            Natural-language description of the maintenance task
            (e.g. "Find orphaned pages and clean up broken links").

        Returns
        -------
        dict:
            A maintenance plan with keys ``summary`` (str) and
            ``actions`` (list[dict]).
        """
        read_only_names = _READ_ONLY_TOOL_NAMES
        tool_list = "\n".join(
            f"- {t.name}: {t.description}"
            for t in self.tools
            if t.name in read_only_names
        )

        prompt = (
            f"You are in **INVESTIGATION** mode.\n\n"
            f"User request: {request}\n\n"
            f"You may ONLY use these read-only tools:\n{tool_list}\n\n"
            f"DO NOT modify any files.\n\n"
            f"After exploring the project, produce a JSON plan:\n"
            f'```json\n{{\n  "summary": "Brief description of the changes",\n'
            f'  "actions": [\n'
            f'    {{"type": "write_file", "path": "...", "content": "..."}},\n'
            f'    {{"type": "delete_file", "path": "..."}},\n'
            f'    {{"type": "rename_file", "old_path": "...", "new_path": "..."}},\n'
            f'    {{"type": "batch_update_frontmatter", "pattern": "wiki/**/*.md", "updates": {{"key": "val"}}}},\n'
            f'    {{"type": "batch_replace_text", "pattern": "wiki/**/*.md", "old_text": "...", "new_text": "..."}}\n'
            f"  ]\n"
            f"}}\n```"
        )

        result = self.agent.invoke({"messages": [HumanMessage(content=prompt)]})
        final = result["messages"][-1]
        response_text = final.content if hasattr(final, "content") else str(final)

        plan = self._parse_plan_from_response(response_text)
        if plan is None:
            return {
                "summary": "Agent did not return a structured plan.",
                "raw_response": response_text,
                "actions": [],
            }

        return plan

    def preview(self, plan: dict) -> dict:
        """Phase 2 — preview changes (dry-run).

        Simulates every action in *plan* and returns the resulting diff.

        Parameters
        ----------
        plan:
            A maintenance plan (as returned by :meth:`investigate`).

        Returns
        -------
        dict:
            Summary with ``plan_summary`` (str) and ``diff`` (list[dict]).
        """
        summary = plan.get("summary", "No summary provided")
        actions = plan.get("actions", [])
        diff_results: list[dict] = []

        for i, action in enumerate(actions):
            action_type = action.get("type", "unknown")
            path = action.get("path") or action.get("old_path", "?")

            try:
                # Capture current content for diff if this is a write action
                old_content = ""
                if action_type in ("write_file", "batch_update_frontmatter", "batch_replace_text"):
                    full_path = self._project_path / path if path != "?" else None
                    if full_path and full_path.is_file():
                        old_content = full_path.read_text(encoding="utf-8")

                # Invoke the tool in dry-run mode
                result_text = self._execute_single_action(action, dry_run=True)

                entry: dict = {
                    "index": i,
                    "type": action_type,
                    "path": path,
                    "result": result_text,
                }

                # Generate content diff for write operations
                if action_type == "write_file" and "path" in action:
                    new_content = action.get("content", "")
                    if old_content and new_content:
                        diff_text = self._generate_diff(old_content, new_content, path)
                        entry["diff"] = diff_text

                diff_results.append(entry)

            except Exception as e:
                diff_results.append({
                    "index": i,
                    "type": action_type,
                    "path": path,
                    "result": f"ERROR: {e}",
                })

        return {
            "plan_summary": summary,
            "diff": diff_results,
            "total_actions": len(actions),
        }

    def execute(self, plan: dict, confirmed: bool = False) -> dict:
        """Phase 3 — execute the plan with automatic snapshot.

        Parameters
        ----------
        plan:
            A maintenance plan (as returned by :meth:`investigate`).
        confirmed:
            Must be ``True`` for execution to proceed.

        Returns
        -------
        dict:
            Execution results with ``plan_summary`` and ``results``.
        """
        if not confirmed:
            return {
                "error": "Execution not confirmed. Set confirmed=True to proceed.",
                "plan_summary": plan.get("summary"),
            }

        summary = plan.get("summary", "No summary provided")
        actions = plan.get("actions", [])

        # Auto-create snapshot before execution
        snapshot_result = None
        if self._version_control is not None:
            try:
                snapshot_result = self._version_control.create_snapshot(
                    "pre-maintenance"
                )
            except Exception as e:
                snapshot_result = f"Snapshot failed: {e}"

        results: list[dict] = []
        for i, action in enumerate(actions):
            action_type = action.get("type", "unknown")
            path = action.get("path") or action.get("old_path", "?")

            try:
                result_text = self._execute_single_action(action, dry_run=False)
                results.append({
                    "index": i,
                    "type": action_type,
                    "path": path,
                    "result": result_text,
                })
            except Exception as e:
                results.append({
                    "index": i,
                    "type": action_type,
                    "path": path,
                    "result": f"ERROR: {e}",
                })

        return {
            "plan_summary": summary,
            "snapshot": str(snapshot_result) if snapshot_result else None,
            "results": results,
            "total_actions": len(actions),
            "succeeded": sum(1 for r in results if not r["result"].startswith("ERROR")),
            "failed": sum(1 for r in results if r["result"].startswith("ERROR")),
        }

    # ------------------------------------------------------------------
    # Action execution
    # ------------------------------------------------------------------

    def _execute_single_action(self, action: dict, dry_run: bool) -> str:
        """Execute a single plan action by invoking the corresponding tool.

        Parameters
        ----------
        action:
            An action dict with at least a ``type`` key.
        dry_run:
            If ``True``, tools are called in preview/simulation mode.

        Returns
        -------
        str:
            The tool's output.
        """
        action_type = action.get("type", "")

        # Map action types to tool references
        tool_map: dict[str, BaseTool] = {
            "read_file": self._read_file_tool,
            "write_file": self._write_file_tool,
            "list_directory": self._list_directory_tool,
            "delete_file": self._delete_file_tool,
            "rename_file": self._rename_file_tool,
            "batch_update_frontmatter": self._batch_update_frontmatter_tool,
            "batch_replace_text": self._batch_replace_text_tool,
            "search_wiki": self._search_wiki_tool,
            "preview_changes": self._preview_changes_tool,
            "create_snapshot": self._snapshot_tool,
        }

        if action_type not in tool_map:
            return f"ERROR: Unknown action type '{action_type}'."

        try:
            kwargs = _build_action_kwargs(action, dry_run=dry_run)
            tool_fn = tool_map[action_type]
            return tool_fn.invoke(kwargs)
        except Exception as e:
            return f"ERROR: {e}"
