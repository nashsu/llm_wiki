"""Parser registry with decorator-based registration."""

from pathlib import Path

from app.parsers.base import DocumentParser, ParseResult

_registry: dict[str, type[DocumentParser]] = {}


def register_parser(extensions: list[str] | None = None):
    """Decorator that registers a DocumentParser subclass.

    If *extensions* is ``None``, the parser's ``supported_extensions``
    property is used to determine which extensions to register for.

    If an extension is already registered, the new parser replaces the old
    one (last-registered wins).
    """

    def decorator(cls: type[DocumentParser]) -> type[DocumentParser]:
        # Create a temporary instance to access @property descriptors
        exts = extensions if extensions is not None else cls().supported_extensions
        for ext in exts:
            _registry[ext] = cls
        return cls

    return decorator


def get_parser(file_path: str) -> DocumentParser | None:
    """Return a parser *instance* for *file_path*, or ``None`` if no parser
    is registered for its extension."""
    ext = Path(file_path).suffix.lower()
    cls = _registry.get(ext)
    if cls is not None:
        return cls()
    return None


def parse_document(file_path: str) -> ParseResult:
    """Parse *file_path* by auto-selecting a registered parser.

    If no parser is registered for the file extension, the file is read as
    plain UTF-8 text as a fallback.
    """
    parser = get_parser(file_path)
    if parser is not None:
        try:
            return parser.parse(file_path)
        except Exception as exc:
            path = Path(file_path)
            return ParseResult(
                text="",
                images=[],
                metadata={"source": str(path), "extension": path.suffix},
                success=False,
                error=str(exc),
            )

    # Fallback -- read as plain text
    path = Path(file_path)
    try:
        text = path.read_text(encoding="utf-8")
        return ParseResult(
            text=text,
            images=[],
            metadata={"source": str(path), "extension": path.suffix},
        )
    except Exception as exc:
        return ParseResult(
            text="",
            images=[],
            metadata={"source": str(path), "extension": path.suffix},
            success=False,
            error=str(exc),
        )


def list_parsers() -> list[dict]:
    """List all registered parser classes and the extensions they cover."""
    seen: dict[type[DocumentParser], list[str]] = {}
    for ext, cls in _registry.items():
        seen.setdefault(cls, []).append(ext)

    return [
        {"name": cls.__name__, "extensions": sorted(exts)}
        for cls, exts in seen.items()
    ]
