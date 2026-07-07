"""Application configuration via pydantic-settings."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment variables / .env file."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "LLM Wiki"
    app_version: str = "0.1.0"
    host: str = "127.0.0.1"
    port: int = 19828
    log_level: str = "INFO"

    # CORS allowed origins
    # Tauri v2 WebView 使用 tauri://localhost 作为 origin，
    # 桌面本地应用允许所有 origin 是安全的。
    cors_origins: list[str] = ["*"]


settings = Settings()
