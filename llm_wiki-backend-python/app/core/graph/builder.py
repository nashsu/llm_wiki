"""Wiki graph builder — scans wiki markdown files and builds a networkx graph."""

import re
from pathlib import Path

import networkx as nx
import yaml

# Regex to extract [[wikilinks]] from markdown content
WIKILINK_PATTERN = re.compile(r"\[\[([^\]]+)\]\]")

# Frontmatter delimiter
FM_DELIMITER = "---"


class WikiGraphBuilder:
    """Builds a NetworkX graph from a wiki directory of markdown files.

    Each file becomes a node; edges represent direct [[wikilinks]] between pages.
    """

    def __init__(self, wiki_path: Path) -> None:
        """Initialize the builder with the path to a wiki directory.

        Args:
            wiki_path: Path to the ``wiki/`` directory containing ``.md`` files.
        """
        self.wiki_path = Path(wiki_path)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def build(self) -> nx.Graph:
        """Scan all markdown files and build a graph.

        Returns:
            A NetworkX ``Graph`` where each node has attributes from its
            YAML frontmatter (``type``, ``title``, ``sources``, ``tags``,
            ``page_path``) and edges represent direct [[wikilinks]].
        """
        graph = nx.Graph()
        md_files = sorted(self.wiki_path.rglob("*.md"))

        # Phase 1: collect all nodes with their metadata
        node_meta: dict[str, dict] = {}
        for md_file in md_files:
            rel_path = md_file.relative_to(self.wiki_path).as_posix()
            content = md_file.read_text(encoding="utf-8")
            metadata = self._parse_frontmatter(content)
            metadata["page_path"] = rel_path
            metadata["file_path"] = str(md_file)
            node_meta[rel_path] = metadata

        # Phase 2: add nodes and edges
        for rel_path, meta in node_meta.items():
            self._add_node(graph, rel_path, meta)

        # Phase 3: add edges based on wikilinks
        page_path_to_rel: dict[str, str] = {}
        for rel_path, meta in node_meta.items():
            title = (meta.get("title") or "").strip().lower()
            if title:
                page_path_to_rel[title] = rel_path

        for rel_path, meta in node_meta.items():
            content = Path(meta["file_path"]).read_text(encoding="utf-8")
            links = self._extract_wikilinks(content)
            for link in links:
                target = self._resolve_wikilink(link, page_path_to_rel, node_meta)
                if target and target != rel_path:
                    graph.add_edge(rel_path, target, type="wikilink")

        return graph

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _parse_frontmatter(content: str) -> dict:
        """Extract YAML frontmatter from a markdown file.

        Expects the file to start with ``---``, followed by YAML, then
        ``---``.  Returns an empty dict if no valid frontmatter is found.

        Args:
            content: Full text content of a markdown file.

        Returns:
            Parsed frontmatter dictionary.
        """
        stripped = content.lstrip("\ufeff").lstrip()
        if not stripped.startswith(FM_DELIMITER):
            return {}
        parts = stripped.split(FM_DELIMITER, 2)
        if len(parts) < 3:
            return {}
        yaml_str = parts[1].strip()
        if not yaml_str:
            return {}
        try:
            metadata = yaml.safe_load(yaml_str)
            if not isinstance(metadata, dict):
                return {}
            return metadata
        except yaml.YAMLError:
            return {}

    @staticmethod
    def _extract_wikilinks(content: str) -> list[str]:
        """Extract all ``[[wikilink]]`` references from content.

        The link text is returned as-is (including any ``|alias`` portion).

        Args:
            content: Markdown text to scan.

        Returns:
            List of wikilink targets (without brackets).
        """
        return WIKILINK_PATTERN.findall(content)

    @staticmethod
    def _resolve_wikilink(
        link: str,
        title_index: dict[str, str],
        node_meta: dict[str, dict],
    ) -> str | None:
        """Resolve a wikilink string to a relative page path.

        Supports:
        - Exact title match (case-insensitive)
        - ``page|alias`` syntax → uses the page part
        - ``path/to/page`` relative path

        Args:
            link: The raw wikilink content (``page`` or ``page|alias``).
            title_index: Mapping of lowercase titles → relative paths.
            node_meta: Mapping of relative paths → metadata dicts.

        Returns:
            Resolved relative path, or ``None`` if unresolvable.
        """
        # Split on pipe to get the actual page reference
        target = link.split("|")[0].strip()
        if not target:
            return None

        target_lower = target.lower().replace("\\", "/")

        # 1. Exact path match
        if target_lower in node_meta:
            return target_lower

        # 2. Title match (case-insensitive)
        if target_lower in title_index:
            return title_index[target_lower]

        # 3. Try appending .md
        with_md = target_lower if target_lower.endswith(".md") else f"{target_lower}.md"
        if with_md in node_meta:
            return with_md

        # 4. Partial path match — search for basename
        basename = target_lower.split("/")[-1]
        for rel_path in node_meta:
            if rel_path.endswith(f"/{basename}.md") or rel_path == f"{basename}.md":
                return rel_path

        return None

    @staticmethod
    def _add_node(graph: nx.Graph, page_path: str, metadata: dict) -> None:
        """Add a node to the graph with metadata attributes.

        Args:
            graph: The NetworkX graph to mutate.
            page_path: Relative path of the page (used as node id).
            metadata: Frontmatter dict (``type``, ``title``, ``sources``,
                      ``tags``, etc.).
        """
        attrs = {
            "page_path": page_path,
            "type": metadata.get("type", "unknown"),
            "title": metadata.get("title", page_path),
            "sources": metadata.get("sources", []),
            "tags": metadata.get("tags", []),
        }
        graph.add_node(page_path, **attrs)
