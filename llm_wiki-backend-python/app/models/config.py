"""Configuration data models for LLM Wiki."""

from datetime import datetime
from enum import Enum
from pydantic import BaseModel, ConfigDict, Field


def _to_camel(name: str) -> str:
    """Convert snake_case to camelCase for JSON alias generation."""
    parts = name.split("_")
    return parts[0] + "".join(p.capitalize() for p in parts[1:])


class CamelCaseModel(BaseModel):
    """Base model with automatic camelCase JSON alias support."""

    model_config = ConfigDict(
        alias_generator=_to_camel,
        populate_by_name=True,
        from_attributes=True,
    )


class ProviderProtocol(str, Enum):
    """Supported LLM provider protocols."""

    OPENAI_COMPATIBLE = "openai"
    ANTHROPIC = "anthropic"
    GOOGLE = "google"


class ModelProvider(CamelCaseModel):
    """An LLM provider configuration with API details."""

    id: str
    name: str
    protocol: ProviderProtocol
    api_base: str | None = None
    api_key: str | None = None
    models: list[str] = []
    default_model: str | None = None
    custom_headers: dict[str, str] = {}
    max_context: int = 128000
    temperature: float = 0.7
    created_at: datetime
    updated_at: datetime


class ProviderRef(CamelCaseModel):
    """Reference to a specific provider and model."""

    provider_id: str
    model: str


class ProviderAssignment(CamelCaseModel):
    """Assignment of providers to different features."""

    chat: "ProviderRef | None" = None
    ingest: "ProviderRef | None" = None
    maintenance: "ProviderRef | None" = None


class SourceWatchConfig(CamelCaseModel):
    """Configuration for source folder auto-watching."""

    enabled: bool = False
    auto_ingest: bool = False
    ignore_patterns: list[str] = []


class ProjectSettings(CamelCaseModel):
    """Project-level general settings."""

    output_language: str = "auto"
    source_watch_config: SourceWatchConfig = Field(
        default_factory=SourceWatchConfig
    )


class ProjectSecrets(CamelCaseModel):
    """Project secrets and provider configurations."""

    providers: list[ModelProvider] = []
    assignment: ProviderAssignment = Field(default_factory=ProviderAssignment)
    search_api_config: dict | None = None
    embedding_config: dict | None = None
    mineru_config: dict | None = None
    proxy_config: dict | None = None
    api_config: dict | None = None


class ProjectConfig(CamelCaseModel):
    """Complete project configuration stored in .llm-wiki/config.json."""

    project_id: str
    created_at: datetime
    settings: ProjectSettings = Field(default_factory=ProjectSettings)
    secrets: ProjectSecrets = Field(default_factory=ProjectSecrets)
