"""Chat agent package.

Provides a LangChain-based chat agent with tool integration, context
building, and streaming support for the LLM Wiki.
"""

from app.core.chat.agent import WikiChatAgent
from app.core.chat.context import ContextBuilder
from app.core.chat.tools import (
    create_list_directory_tool,
    create_read_page_tool,
    create_read_source_tool,
    create_search_wiki_tool,
)

__all__ = [
    "WikiChatAgent",
    "ContextBuilder",
    "create_search_wiki_tool",
    "create_read_page_tool",
    "create_list_directory_tool",
    "create_read_source_tool",
]
