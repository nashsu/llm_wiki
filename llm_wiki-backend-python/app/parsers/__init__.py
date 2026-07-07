"""File parsers package.

Importing this package triggers automatic registration of built-in parsers
via the ``@register_parser`` decorator defined in :mod:`app.parsers.registry`.
"""

from app.parsers.base import DocumentParser, ExtractedImage, ParseResult
from app.parsers.registry import get_parser, list_parsers, parse_document, register_parser

# Import builtin parsers so their @register_parser decorators fire
from app.parsers import builtin  # noqa: F401
from app.parsers import pdf  # noqa: F401
from app.parsers import docx  # noqa: F401
from app.parsers import xlsx  # noqa: F401
from app.parsers import pptx  # noqa: F401

__all__ = [
    "DocumentParser",
    "ExtractedImage",
    "ParseResult",
    "register_parser",
    "get_parser",
    "parse_document",
    "list_parsers",
]
