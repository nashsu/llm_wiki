"""Ingestion cache with SHA256 content normalization and mtime pre-check.

Combines strategies A (content normalisation) + D (mtime pre-check) from the
design document.  Cache entries are persisted as a single JSON file so that
state survives application restarts.
"""

import hashlib
import json
import logging
import time
import unicodedata
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Content normalisation  (strategy A)
# ---------------------------------------------------------------------------


def normalize_content(text: str) -> str:
    """Normalise *text* for cross-platform, deterministic hashing.

    Steps
    -----
    1.  NFC Unicode normalisation
    2.  ``\\r\\n`` → ``\\n``, ``\\r`` → ``\\n``
    3.  ``rstrip()`` + ``\\n``  (guaranteed trailing newline)
    """
    normalized = unicodedata.normalize("NFC", text)
    normalized = normalized.replace("\r\n", "\n").replace("\r", "\n")
    normalized = normalized.rstrip() + "\n"
    return normalized


def content_hash(text: str) -> str:
    """SHA-256 digest of the *normalised* content."""
    return hashlib.sha256(normalize_content(text).encode()).hexdigest()


# ---------------------------------------------------------------------------
# Cache entry
# ---------------------------------------------------------------------------


@dataclass
class CacheEntry:
    """A single cache entry for one source file."""

    content_hash: str
    file_size: int
    mtime: float
    files_written: list[str]
    timestamp: float


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------


class IngestCache:
    """Persistent ingestion cache backed by ``cache.json``.

    Cache location: ``{cache_dir}/cache.json``

    Usage::

        cache = IngestCache(".llm-wiki/cache")
        status = cache.check("raw/sources/doc.pdf", content, size, mtime)
        if status == "MISS":
            pipeline.run(...)
            cache.update("raw/sources/doc.pdf", content, size, mtime, pages)
    """

    CACHE_FILE = "cache.json"

    def __init__(self, cache_dir: str | Path) -> None:
        self._cache_dir = Path(cache_dir)
        self._cache_dir.mkdir(parents=True, exist_ok=True)
        self._cache_file = self._cache_dir / self.CACHE_FILE
        self._cache: dict[str, dict[str, Any]] = {}
        self._load()

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def _load(self) -> None:
        """Load cache entries from ``cache.json`` on disk."""
        if self._cache_file.exists():
            try:
                data = json.loads(self._cache_file.read_text(encoding="utf-8"))
                self._cache = data if isinstance(data, dict) else {}
                logger.debug("Loaded cache with %d entries", len(self._cache))
            except (json.JSONDecodeError, OSError) as exc:
                logger.warning("Failed to load cache, starting fresh: %s", exc)
                self._cache = {}

    def _save(self) -> None:
        """Write cache to disk atomically (tmp + rename)."""
        tmp = self._cache_file.with_suffix(".tmp")
        try:
            tmp.write_text(
                json.dumps(self._cache, indent=2, ensure_ascii=False),
                encoding="utf-8",
            )
            tmp.replace(self._cache_file)
        except OSError as exc:
            logger.error("Failed to save cache: %s", exc)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def check(
        self,
        source_id: str,
        content: str,
        file_size: int,
        mtime: float,
    ) -> str:
        """Check whether a source file has been cached.

        Returns one of:

        ``"HIT"``
            Cached content matches the current file.  Safe to skip ingestion.

        ``"MISS"``
            No cache entry, file size differs, or content hash differs.
            Full ingestion required.

        ``"STALE"``
            Reserved for future use (e.g. ``.syncme`` flag support).
            Currently unused but documented for callers that may rely on
            a third state.
        """
        entry = self._cache.get(source_id)
        if entry is None:
            return "MISS"

        # --- Size check ---------------------------------------------------
        if entry["file_size"] != file_size:
            return "MISS"

        # --- mtime pre-check (strategy D — zero-cost fast path) -----------
        if entry["mtime"] == mtime:
            return "HIT"

        # --- Hash verification (strategy A — compute after mtime change) --
        h = content_hash(content)
        if entry["content_hash"] == h:
            # Content unchanged — just refresh the stored mtime
            entry["mtime"] = mtime
            entry["timestamp"] = time.time()
            self._save()
            return "HIT"

        return "MISS"

    def update(
        self,
        source_id: str,
        content: str,
        file_size: int,
        mtime: float,
        files_written: list[str],
    ) -> None:
        """Create or refresh a cache entry after successful ingestion."""
        entry = CacheEntry(
            content_hash=content_hash(content),
            file_size=file_size,
            mtime=mtime,
            files_written=files_written,
            timestamp=time.time(),
        )
        self._cache[source_id] = asdict(entry)
        self._save()

    def remove(self, source_id: str) -> None:
        """Delete a cache entry."""
        self._cache.pop(source_id, None)
        self._save()

    def get_files_written(self, source_id: str) -> list[str]:
        """Return the list of files written during the last ingestion of
        *source_id*, or an empty list if the source is not cached."""
        entry = self._cache.get(source_id)
        if entry is None:
            return []
        return list(entry["files_written"])

    @property
    def entries(self) -> dict[str, dict[str, Any]]:
        """Return a snapshot of all cache entries (read-only copy)."""
        return dict(self._cache)
