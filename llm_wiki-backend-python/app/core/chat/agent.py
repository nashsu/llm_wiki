"""Wiki Chat Agent — LangChain agent with tool integration and streaming.

The ``WikiChatAgent`` uses ``create_agent`` (LangGraph-based) with
a custom system prompt assembled from the ``chat-agent-router`` and
``chat-agent-answer`` templates.  It exposes both a synchronous
``chat()`` method and an async ``stream_chat()`` generator for SSE.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, AsyncIterator

from jinja2 import Template
from langchain.agents import AgentState, create_agent
from langchain_core.chat_history import InMemoryChatMessageHistory
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from app.core.chat.tools import (
    create_list_directory_tool,
    create_read_page_tool,
    create_read_source_tool,
    create_search_wiki_tool,
)
from app.core.prompts.manager import PromptManager

_MAX_ITERATIONS = 10


def _load_text_file(path: Path) -> str:
    """Read a text file, returning empty string on failure."""
    try:
        return path.read_text(encoding="utf-8")
    except Exception:
        return ""


class WikiChatAgent:
    """LangChain-powered chat agent for the LLM Wiki.

    Parameters
    ----------
    llm:
        A LangChain ``BaseChatModel`` instance (created via
        ``LLMFactory``).
    project_path:
        Absolute filesystem path to the Wiki project.
    prompt_manager:
        A ``PromptManager`` instance for loading templates.
    search_engine:
        Optional search engine instance.  If ``None``, the search tool
        will return a fallback message.
    """

    def __init__(
        self,
        llm: BaseChatModel,
        project_path: str,
        prompt_manager: PromptManager,
        search_engine: Any | None = None,
    ) -> None:
        self._llm = llm
        self._project_path = Path(project_path).resolve()
        self._prompt_manager = prompt_manager
        self._search_engine = search_engine

        # Conversation history (per-instance, single conversation)
        self.history = InMemoryChatMessageHistory()

        # Register tools (must happen before building system prompt)
        self.tools = [
            create_search_wiki_tool(search_engine),
            create_read_page_tool(project_path),
            create_list_directory_tool(project_path),
            create_read_source_tool(project_path),
        ]

        # Build system prompt from both templates
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
        """Assemble the system prompt from the two chat templates."""
        root = self._project_path

        # Load templates
        router_text = self._prompt_manager.load("chat-agent-router")
        answer_text = self._prompt_manager.load("chat-agent-answer")

        # Gather available context files
        purpose = _load_text_file(root / "purpose.md")
        index = _load_text_file(root / "index.md")
        overview = _load_text_file(root / "overview.md")

        # Tool descriptions for the prompt (as a formatted string)
        tool_lines = []
        for tool in self.tools:
            tool_lines.append(f"- ``{tool.name}``: {tool.description}")
        tool_descriptions = "\n".join(tool_lines)

        # Render router prompt
        router_prompt = Template(router_text).render(
            language_directive="Respond in the language the user wrote in.",
            purpose=purpose or "A general-purpose Wiki.",
            index=index or "(No index available)",
            tool_descriptions=tool_descriptions,
        )

        # Render answer prompt — replace context-dependent variables
        # with instructions since the agent gathers context at runtime.
        answer_prompt = Template(answer_text).render(
            language_directive="Respond in the language the user wrote in.",
            purpose=purpose or "A general-purpose Wiki.",
            overview=overview or "(No overview available)",
            chat_history=(
                "(Previous messages are provided in the conversation "
                "history; refer to them as needed.)"
            ),
            context_pages=(
                "(Use the search_wiki and read_page tools to gather "
                "relevant context from the Wiki.)"
            ),
        )

        return f"{router_prompt}\n\n{answer_prompt}"

    @staticmethod
    def _convert_history(history: list[dict] | None) -> list:
        """Convert a list of ``{role, content}`` dicts to LangChain messages.

        Returns an empty list when *history* is ``None`` or empty.
        """
        if not history:
            return []
        messages: list = []
        for msg in history:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            if role == "user":
                messages.append(HumanMessage(content=content))
            elif role == "assistant":
                messages.append(AIMessage(content=content))
            elif role == "system":
                messages.append(SystemMessage(content=content))
            else:
                messages.append(HumanMessage(content=content))
        return messages

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def chat(self, message: str, history: list[dict] | None = None) -> str:
        """Send a message and get a synchronous response.

        Parameters
        ----------
        message:
            The user's message.
        history:
            Optional conversation history as ``[{role, content}, ...]``.

        Returns
        -------
        str:
            The agent's response text.
        """
        messages = self._convert_history(history)
        messages.append(HumanMessage(content=message))

        result = self.agent.invoke({"messages": messages})

        # The last message in the result is the assistant's response
        final = result["messages"][-1]
        response = final.content if hasattr(final, "content") else str(final)

        # Update local history
        self.history.add_user_message(message)
        self.history.add_ai_message(response)

        return response

    async def stream_chat(
        self,
        message: str,
        history: list[dict] | None = None,
    ) -> AsyncIterator[str]:
        """Stream a response token-by-token via ``astream_events``.

        Parameters
        ----------
        message:
            The user's message.
        history:
            Optional conversation history as ``[{role, content}, ...]``.

        Yields
        ------
        str:
            Tokens or event notifications.  Event notifications use the
            format ``[event_type: detail]``.
        """
        messages = self._convert_history(history)
        messages.append(HumanMessage(content=message))

        full_response = ""

        async for event in self.agent.astream_events(
            {"messages": messages},
            version="v2",
        ):
            kind = event["event"]
            if kind == "on_chat_model_stream":
                chunk = event["data"].get("chunk")
                if chunk is not None and hasattr(chunk, "content"):
                    token = chunk.content or ""
                    if token:
                        full_response += token
                        yield token

            elif kind == "on_tool_start":
                name = event.get("name", "unknown")
                yield f"[Using tool: {name}]"

            elif kind == "on_tool_end":
                name = event.get("name", "unknown")
                yield f"[Tool completed: {name}]"

        # Update local history
        self.history.add_user_message(message)
        if full_response:
            self.history.add_ai_message(full_response)
