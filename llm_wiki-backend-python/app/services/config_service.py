"""Configuration services: global SQLite preferences + per-project config."""

import json
import os
import sqlite3
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from app.models.config import (
    ModelProvider,
    ProjectConfig,
    ProjectSecrets,
    ProjectSettings,
    ProviderRef,
)


def _get_global_db_path() -> Path:
    """Get the path to the global SQLite database.

    Windows: %APPDATA%/llm-wiki/settings.db
    Fallback (Linux/macOS): ~/.local/share/llm-wiki/settings.db
    """
    appdata = os.environ.get("APPDATA")
    if appdata:
        db_dir = Path(appdata) / "llm-wiki"
    else:
        home = Path.home()
        xdg = os.environ.get("XDG_DATA_HOME")
        if xdg:
            db_dir = Path(xdg) / "llm-wiki"
        else:
            db_dir = home / ".local" / "share" / "llm-wiki"
    db_dir.mkdir(parents=True, exist_ok=True)
    return db_dir / "settings.db"


def mask_api_key(key: str | None) -> str | None:
    """Mask an API key showing only first 4 and last 4 characters."""
    if not key or len(key) <= 8:
        return key
    return key[:4] + "****" + key[-4:]


def mask_project_config(config: ProjectConfig) -> ProjectConfig:
    """Return a deep copy of config with sensitive fields masked."""
    masked = config.model_copy(deep=True)
    for provider in masked.secrets.providers:
        provider.api_key = mask_api_key(provider.api_key)
    return masked


class GlobalConfigService:
    """Manages global application preferences via SQLite.

    Stores preferences (JSON key-value), recent projects list, and last
    opened project in a local SQLite database.
    """

    def __init__(self, db_path: str | Path | None = None) -> None:
        self.db_path = Path(db_path) if db_path else _get_global_db_path()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.init_db()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        return conn

    def init_db(self) -> None:
        """Create database tables if they do not exist."""
        with self._connect() as conn:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS preferences (
                    key   TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS recent_projects (
                    path        TEXT PRIMARY KEY,
                    name        TEXT NOT NULL,
                    last_opened TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS last_project (
                    path TEXT PRIMARY KEY,
                    name TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS providers (
                    id             TEXT PRIMARY KEY,
                    name           TEXT NOT NULL,
                    protocol       TEXT NOT NULL DEFAULT 'openai',
                    api_base       TEXT NOT NULL DEFAULT '',
                    api_key        TEXT NOT NULL DEFAULT '',
                    models         TEXT NOT NULL DEFAULT '[]',
                    default_model  TEXT NOT NULL DEFAULT '',
                    custom_headers TEXT NOT NULL DEFAULT '{}',
                    max_context    INTEGER NOT NULL DEFAULT 128000,
                    temperature    REAL NOT NULL DEFAULT 0.7,
                    created_at     TEXT NOT NULL,
                    updated_at     TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS assignments (
                    feature     TEXT PRIMARY KEY,
                    provider_id TEXT,
                    model       TEXT,
                    FOREIGN KEY (provider_id) REFERENCES providers(id)
                );
            """)

    # ── Preferences ──────────────────────────────────────────────

    def get_preference(self, key: str) -> str | None:
        """Get a preference value (JSON-encoded string)."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT value FROM preferences WHERE key = ?", (key,)
            ).fetchone()
            return row["value"] if row else None

    def set_preference(self, key: str, value: str) -> None:
        """Set a preference value (must be a JSON-encoded string)."""
        with self._connect() as conn:
            conn.execute(
                """INSERT INTO preferences (key, value) VALUES (?, ?)
                   ON CONFLICT(key) DO UPDATE SET value = excluded.value""",
                (key, value),
            )

    # ── Recent Projects ──────────────────────────────────────────

    def get_recent_projects(self) -> list[dict[str, Any]]:
        """Return recent projects sorted by last_opened descending."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT path, name, last_opened FROM recent_projects "
                "ORDER BY last_opened DESC"
            ).fetchall()
            return [dict(row) for row in rows]

    def add_recent_project(self, path: str, name: str) -> None:
        """Add or update a recent project entry."""
        now = datetime.now().isoformat()
        with self._connect() as conn:
            conn.execute(
                """INSERT INTO recent_projects (path, name, last_opened)
                   VALUES (?, ?, ?)
                   ON CONFLICT(path) DO UPDATE SET
                       name = excluded.name,
                       last_opened = excluded.last_opened""",
                (path, name, now),
            )

    def remove_recent_project(self, path: str) -> None:
        """Remove a project from the recent projects list."""
        with self._connect() as conn:
            conn.execute(
                "DELETE FROM recent_projects WHERE path = ?", (path,)
            )

    # ── Last Project ─────────────────────────────────────────────

    def get_last_project(self) -> dict[str, str] | None:
        """Get the last opened project info."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT path, name FROM last_project LIMIT 1"
            ).fetchone()
            return dict(row) if row else None

    def set_last_project(self, path: str, name: str) -> None:
        """Set the last opened project (replaces any previous entry)."""
        with self._connect() as conn:
            conn.execute("DELETE FROM last_project")
            conn.execute(
                "INSERT INTO last_project (path, name) VALUES (?, ?)",
                (path, name),
            )


    # ── Provider CRUD ─────────────────────────────────────────────

    def _row_to_provider(self, row: sqlite3.Row) -> dict:
        """Convert a SQLite row to a provider dict with parsed JSON fields."""
        d = dict(row)
        if isinstance(d.get("models"), str):
            d["models"] = json.loads(d["models"])
        if isinstance(d.get("custom_headers"), str):
            d["custom_headers"] = json.loads(d["custom_headers"])
        return d

    def list_providers(self) -> list[dict[str, Any]]:
        """List all providers with unmasked API keys."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM providers ORDER BY name"
            ).fetchall()
            return [self._row_to_provider(r) for r in rows]

    def get_provider(self, provider_id: str) -> dict[str, Any] | None:
        """Get a single provider by ID, or None if not found."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM providers WHERE id = ?", (provider_id,)
            ).fetchone()
            return self._row_to_provider(row) if row else None

    def add_provider(self, data: dict) -> dict[str, Any]:
        """Add a new provider.

        Expects a dict with snake_case keys matching the providers table
        columns.  Returns the saved provider dict.
        """
        now = data.get("created_at", datetime.now().isoformat())
        record = {
            "id": data["id"],
            "name": data["name"],
            "protocol": data.get("protocol", "openai"),
            "api_base": data.get("api_base", ""),
            "api_key": data.get("api_key", ""),
            "models": json.dumps(data.get("models", [])),
            "default_model": data.get("default_model", ""),
            "custom_headers": json.dumps(data.get("custom_headers", {})),
            "max_context": data.get("max_context", 128000),
            "temperature": data.get("temperature", 0.7),
            "created_at": now if isinstance(now, str) else now.isoformat(),
            "updated_at": now if isinstance(now, str) else now.isoformat(),
        }
        with self._connect() as conn:
            conn.execute(
                """INSERT INTO providers
                   (id, name, protocol, api_base, api_key, models,
                    default_model, custom_headers, max_context, temperature,
                    created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                tuple(record[k] for k in (
                    "id", "name", "protocol", "api_base", "api_key", "models",
                    "default_model", "custom_headers", "max_context", "temperature",
                    "created_at", "updated_at"
                )),
            )
        return self._row_to_provider(
            conn.execute("SELECT * FROM providers WHERE id = ?", (data["id"],)).fetchone()
        )

    def update_provider(self, provider_id: str, data: dict) -> dict[str, Any] | None:
        """Update an existing provider.

        Only the fields present in *data* are updated.  Returns the
        updated provider dict, or None if the provider was not found.
        """
        existing = self.get_provider(provider_id)
        if not existing:
            return None

        now = datetime.now().isoformat()
        merged = dict(existing)
        merged.update(data)
        merged["updated_at"] = now

        record = {
            "id": merged["id"],
            "name": merged["name"],
            "protocol": merged.get("protocol", "openai"),
            "api_base": merged.get("api_base", ""),
            "api_key": merged.get("api_key", ""),
            "models": json.dumps(merged.get("models", [])),
            "default_model": merged.get("default_model", ""),
            "custom_headers": json.dumps(merged.get("custom_headers", {})),
            "max_context": merged.get("max_context", 128000),
            "temperature": merged.get("temperature", 0.7),
            "created_at": merged["created_at"],
            "updated_at": now,
        }
        with self._connect() as conn:
            conn.execute(
                """UPDATE providers SET
                   name=?, protocol=?, api_base=?, api_key=?, models=?,
                   default_model=?, custom_headers=?, max_context=?,
                   temperature=?, updated_at=?
                   WHERE id=?""",
                (record["name"], record["protocol"], record["api_base"],
                 record["api_key"], record["models"], record["default_model"],
                 record["custom_headers"], record["max_context"],
                 record["temperature"], record["updated_at"],
                 provider_id),
            )
        return self.get_provider(provider_id)

    def delete_provider(self, provider_id: str) -> bool:
        """Delete a provider and clean up any assignments referencing it.

        Returns True if the provider was deleted, False if not found.
        """
        with self._connect() as conn:
            cur = conn.execute("DELETE FROM providers WHERE id = ?", (provider_id,))
            if cur.rowcount == 0:
                return False
            # Clean up assignments referencing this provider
            conn.execute(
                "UPDATE assignments SET provider_id = NULL, model = NULL "
                "WHERE provider_id = ?", (provider_id,)
            )
            return True

    # ── Assignment ────────────────────────────────────────────────

    def get_assignment(self) -> dict[str, dict[str, str] | None]:
        """Get all feature-to-provider assignments.

        Returns a dict like ``{"chat": {"providerId": ..., "model": ...} | None, ...}``.
        """
        with self._connect() as conn:
            rows = conn.execute("SELECT * FROM assignments").fetchall()
            result: dict[str, dict[str, str] | None] = {}
            for row in rows:
                d = dict(row)
                if d.get("provider_id"):
                    result[d["feature"]] = {
                        "providerId": d["provider_id"],
                        "model": d["model"] or "",
                    }
                else:
                    result[d["feature"]] = None
            return result

    def update_assignment(self, assignment: dict) -> dict[str, dict[str, str] | None]:
        """Update feature-to-provider assignments.

        *assignment* is a dict like ``{"chat": {"providerId": ..., "model": ...} | None, ...}``.
        Returns the full current assignment dict.
        """
        with self._connect() as conn:
            for feature in ("chat", "ingest", "maintenance"):
                raw = assignment.get(feature)
                if raw is not None and isinstance(raw, dict):
                    conn.execute(
                        """INSERT INTO assignments (feature, provider_id, model)
                           VALUES (?, ?, ?)
                           ON CONFLICT(feature) DO UPDATE SET
                               provider_id = excluded.provider_id,
                               model = excluded.model""",
                        (feature, raw.get("providerId", ""), raw.get("model", "")),
                    )
                else:
                    conn.execute(
                        "DELETE FROM assignments WHERE feature = ?", (feature,)
                    )
        return self.get_assignment()

    # ── Connection Test ───────────────────────────────────────────

    def test_connection(self, provider_id: str) -> dict:
        """Test connectivity for a provider by ID.

        Returns the same dict shape as ``LLMFactory.test_connection``.
        """
        provider = self.get_provider(provider_id)
        if not provider:
            return {
                "success": False,
                "model": None,
                "context_window": None,
                "latency_ms": None,
                "error": "Provider not found",
            }
        from app.core.llm.factory import LLMFactory  # avoid circular import at module level
        mp = ModelProvider(**provider)
        return LLMFactory.test_connection(mp)


class ProjectConfigService:
    """Manages per-project configuration stored in .llm-wiki/config.json."""

    @staticmethod
    def _config_path(project_path: str) -> Path:
        return Path(project_path) / ".llm-wiki" / "config.json"

    def load(self, project_path: str) -> ProjectConfig:
        """Load project config from disk, returning defaults if missing."""
        path = self._config_path(project_path)
        if not path.exists():
            return ProjectConfig(
                project_id=Path(project_path).name,
                created_at=datetime.now(),
            )
        data = json.loads(path.read_text(encoding="utf-8"))
        return ProjectConfig.model_validate(data)

    def save(self, project_path: str, config: ProjectConfig) -> None:
        """Save project config to disk with restricted permissions."""
        path = self._config_path(project_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        data = config.model_dump(
            by_alias=True, exclude_none=True, mode="json"
        )
        path.write_text(
            json.dumps(data, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        # Best-effort 0600 permission (meaningful on Unix, no-op on Windows)
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass

    def get_provider(
        self, project_path: str, provider_id: str
    ) -> ModelProvider | None:
        """Get a specific provider by ID from project config."""
        config = self.load(project_path)
        for p in config.secrets.providers:
            if p.id == provider_id:
                return p
        return None

    def get_assignment(
        self, project_path: str, feature: str
    ) -> ProviderRef | None:
        """Get the provider assigned to a specific feature (chat/ingest/maintenance)."""
        config = self.load(project_path)
        return getattr(config.secrets.assignment, feature, None)
