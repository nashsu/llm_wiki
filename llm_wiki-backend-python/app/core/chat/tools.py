"""LangChain tools for the Wiki Chat Agent.

Each factory function creates a ``BaseTool`` using the ``@tool`` decorator.
Tools capture their dependencies (search engine, project path) via closure.
"""

from pathlib import Path
from typing import Any

from langchain_core.tools import BaseTool, tool


def create_search_wiki_tool(search_engine: Any | None = None) -> BaseTool:
    """Create a tool that searches Wiki content.

    Args:
        search_engine:
            Optional search engine instance with a ``search(query)`` method
            returning ``list[dict]`` with ``path`` and ``snippet`` keys.

    Returns:
        A LangChain ``BaseTool`` instance.
    """
    has_engine = search_engine is not None and hasattr(search_engine, "search")

    @tool
    def search_wiki(query: str) -> str:
        """Search the Wiki for pages matching the given query.

        Use this tool when you need to find information in the Wiki.
        Provide a concise search query describing what you are looking for.
        Returns a formatted list of matching pages with paths and snippets.
        """
        if not has_engine:
            return (
                "Search engine is not available. "
                "Try using list_directory and read_page tools instead."
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


def create_read_page_tool(project_path: str) -> BaseTool:
    """Create a tool that reads Wiki page content.

    Args:
        project_path: Root path of the Wiki project.

    Returns:
        A LangChain ``BaseTool`` instance.
    """
    root = Path(project_path).resolve()

    @tool
    def read_page(path: str) -> str:
        """Read the full content of a Wiki page.

        Use this tool when you need to read the complete content of a
        specific Wiki page.  Provide the relative path to the page, e.g.
        ``wiki/entities/python.md``.
        """
        full_path = (root / path).resolve()
        if not str(full_path).startswith(str(root)):
            return f"Error: Path '{path}' is outside the project directory."
        if not full_path.exists():
            return f"Error: Page not found at '{path}'."
        if not full_path.is_file():
            return f"Error: '{path}' is not a file."
        try:
            return full_path.read_text(encoding="utf-8")
        except Exception as e:
            return f"Error reading page: {e}"

    return read_page


def create_list_directory_tool(project_path: str) -> BaseTool:
    """Create a tool that lists Wiki directory structure.

    Args:
        project_path: Root path of the Wiki project.

    Returns:
        A LangChain ``BaseTool`` instance.
    """
    root = Path(project_path).resolve()

    @tool
    def list_directory(path: str = "") -> str:
        """List files and subdirectories in a Wiki directory.

        Use this tool to explore the Wiki structure.  Provide a relative
        path (e.g. ``wiki``, ``wiki/entities``).  Leave empty to list the
        project root.
        """
        target = root / path if path else root
        full_path = target.resolve()
        if not str(full_path).startswith(str(root)):
            return f"Error: Path '{path}' is outside the project directory."
        if not full_path.exists():
            return f"Error: Directory not found at '{path}'."
        if not full_path.is_dir():
            return f"Error: '{path}' is not a directory."

        entries = sorted(full_path.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower()))
        lines = [f"Contents of /{path}:"]
        for entry in entries:
            suffix = "/" if entry.is_dir() else ""
            lines.append(f"  {entry.name}{suffix}")
        return "\n".join(lines)

    return list_directory


def create_read_source_tool(project_path: str) -> BaseTool:
    """Create a tool that reads raw source files.

    Args:
        project_path: Root path of the Wiki project.

    Returns:
        A LangChain ``BaseTool`` instance.
    """
    root = Path(project_path).resolve()

    @tool
    def read_source(path: str) -> str:
        """Read the content of a raw source file.

        Use this tool when you need to examine the original source
        material that was used to create Wiki pages.  Provide the relative
        path (e.g. ``raw/sources/document.pdf.md``).
        """
        full_path = (root / path).resolve()
        if not str(full_path).startswith(str(root)):
            return f"Error: Path '{path}' is outside the project directory."
        if not full_path.exists():
            return f"Error: Source file not found at '{path}'."
        if not full_path.is_file():
            return f"Error: '{path}' is not a file."
        try:
            return full_path.read_text(encoding="utf-8")
        except Exception as e:
            return f"Error reading source file: {e}"

    return read_source
