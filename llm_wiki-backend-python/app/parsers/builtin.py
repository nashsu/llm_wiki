"""Built-in document parsers (Markdown & PlainText).

These parsers are automatically registered when the ``app.parsers`` package
is imported via the ``@register_parser`` decorator.
"""

from pathlib import Path

from app.parsers.base import DocumentParser, ParseResult
from app.parsers.registry import register_parser


@register_parser()
class MarkdownParser(DocumentParser):
    """Parser for Markdown files (.md, .mdx, .markdown, .txt)."""

    @property
    def supported_extensions(self) -> list[str]:
        return [".md", ".mdx", ".txt", ".markdown"]

    def parse(self, file_path: str) -> ParseResult:
        path = Path(file_path)
        text = path.read_text(encoding="utf-8")
        return ParseResult(
            text=text,
            images=[],
            metadata={
                "source": str(path),
                "extension": path.suffix,
                "parser": self.name,
            },
        )


@register_parser()
class PlainTextParser(DocumentParser):
    """Parser for plain-text / code files.

    Note: ``.txt`` is also claimed by :class:`MarkdownParser`; the
    last-registered parser wins (PlainTextParser for ``.txt``).
    """

    @property
    def supported_extensions(self) -> list[str]:
        return [
            ".txt",
            ".log",
            ".csv",
            ".json",
            ".xml",
            ".yaml",
            ".yml",
            ".toml",
            ".ini",
            ".cfg",
            ".py",
            ".js",
            ".ts",
            ".html",
            ".css",
        ]

    def parse(self, file_path: str) -> ParseResult:
        path = Path(file_path)
        text = path.read_text(encoding="utf-8")
        return ParseResult(
            text=text,
            images=[],
            metadata={
                "source": str(path),
                "extension": path.suffix,
                "parser": self.name,
            },
        )
