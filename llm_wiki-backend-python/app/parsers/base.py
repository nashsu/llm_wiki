"""Parser base classes and data models."""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


@dataclass
class ExtractedImage:
    """Represents an image extracted from a document."""

    filename: str
    data: bytes
    mime_type: str
    width: int = 0
    height: int = 0


@dataclass
class ParseResult:
    """Result of parsing a document."""

    text: str
    images: list[ExtractedImage]
    metadata: dict[str, Any]
    success: bool = True
    error: str | None = None


class DocumentParser(ABC):
    """Abstract base class for document parsers."""

    @property
    @abstractmethod
    def supported_extensions(self) -> list[str]:
        """Return list of supported file extensions (with dot, e.g. ['.md', '.txt'])."""
        ...

    @abstractmethod
    def parse(self, file_path: str) -> ParseResult:
        """Parse the file at the given path and return a ParseResult."""
        ...

    @property
    def supports_images(self) -> bool:
        """Whether this parser supports extracting images."""
        return False

    @property
    def name(self) -> str:
        """Return the class name of this parser."""
        return self.__class__.__name__
