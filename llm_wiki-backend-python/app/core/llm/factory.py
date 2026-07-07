"""LLM Factory 鈥?creates LangChain model instances from provider config."""

import time

from langchain_anthropic import ChatAnthropic
from langchain_core.language_models import BaseChatModel
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_openai import ChatOpenAI

from app.models.config import (
    ModelProvider,
    ProviderAssignment,
    ProviderProtocol,
)

_CONNECTION_TIMEOUT_S = 10


class LLMFactory:
    """Factory for creating LangChain chat model instances.

    Provides static methods to create ``BaseChatModel`` instances from
    ``ModelProvider`` configurations and to test connectivity.
    """

    @staticmethod
    def create(provider: ModelProvider) -> BaseChatModel:
        """Create a LangChain ``BaseChatModel`` from a provider configuration.

        Args:
            provider: The provider configuration to use.

        Returns:
            A LangChain chat model instance.

        Raises:
            ValueError: If the provider protocol is unsupported.
        """
        model_name = provider.default_model or (provider.models[0] if provider.models else "gpt-4o")

        match provider.protocol:
            case ProviderProtocol.OPENAI_COMPATIBLE:
                kwargs: dict = {
                    "model": model_name,
                    "api_key": provider.api_key,
                    "temperature": 0,
                    "timeout": _CONNECTION_TIMEOUT_S,
                }
                if provider.api_base:
                    kwargs["base_url"] = provider.api_base
                kwargs["default_headers"] = provider.custom_headers
                return ChatOpenAI(**kwargs)

            case ProviderProtocol.ANTHROPIC:
                kwargs = {
                    "model": model_name,
                    "api_key": provider.api_key,
                    "temperature": 0,
                    "timeout": _CONNECTION_TIMEOUT_S,
                }
                if provider.api_base:
                    kwargs["base_url"] = provider.api_base
                return ChatAnthropic(**kwargs)

            case ProviderProtocol.GOOGLE:
                kwargs = {
                    "model": model_name,
                    "api_key": provider.api_key,
                    "temperature": 0,
                    "timeout": _CONNECTION_TIMEOUT_S,
                }
                return ChatGoogleGenerativeAI(**kwargs)

            case _:
                raise ValueError(f"Unsupported provider protocol: {provider.protocol}")

    @staticmethod
    def create_for_feature(
        assignment: ProviderAssignment,
        providers: dict[str, ModelProvider],
        feature: str,
    ) -> BaseChatModel:
        """Resolve a provider by feature name and create a LangChain model.

        Args:
            assignment: The current feature-to-provider assignment.
            providers: A mapping of ``provider_id 鈫?ModelProvider``.
            feature: The feature name (``"chat"``, ``"ingest"``, ``"maintenance"``).

        Returns:
            A LangChain chat model instance.

        Raises:
            ValueError: If the feature is not assigned or the provider is missing.
        """
        ref = getattr(assignment, feature, None)
        if ref is None:
            raise ValueError(f"No provider assigned for feature: {feature}")

        provider = providers.get(ref.provider_id)
        if provider is None:
            raise ValueError(f"Provider not found: {ref.provider_id}")

        # Override model with the one specified in the assignment
        provider_with_model = provider.model_copy(update={"default_model": ref.model})
        return LLMFactory.create(provider_with_model)

    @staticmethod
    def test_connection(provider: ModelProvider) -> dict:
        """Test connectivity to an LLM provider.

        Sends a minimal prompt and checks for a valid response within a
        10-second timeout.

        Args:
            provider: The provider configuration to test.

        Returns:
            A dict with keys:
            - ``success`` (bool)
            - ``model`` (str | None)
            - ``context_window`` (int | None)
            - ``latency_ms`` (int | None)
            - ``error`` (str | None)
        """
        if not provider.api_key:
            return {
                "success": False,
                "model": provider.default_model,
                "context_window": None,
                "latency_ms": None,
                "error": "No API key configured",
            }

        try:
            llm = LLMFactory.create(provider)
            start = time.monotonic()
            response = llm.invoke("Hi")  # minimal connectivity check
            elapsed_ms = int((time.monotonic() - start) * 1000)

            return {
                "success": True,
                "model": provider.default_model,
                "context_window": provider.max_context,
                "latency_ms": elapsed_ms,
                "error": None,
            }
        except Exception as exc:
            return {
                "success": False,
                "model": provider.default_model,
                "context_window": None,
                "latency_ms": None,
                "error": str(exc),
            }
