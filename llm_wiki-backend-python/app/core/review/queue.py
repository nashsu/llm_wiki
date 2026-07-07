"""Review queue — persistent async human-in-the-loop review queue.

Stores review items as a JSON file under the project's ``.llm-wiki/review/``
directory.  Each item tracks type, severity, status, and resolution.
"""

import json
import uuid
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# Enumerations
# ---------------------------------------------------------------------------


class ReviewItemType(str, Enum):
    """Types of review items that the LLM can flag."""

    QUALITY_ISSUE = "quality_issue"
    MISSING_SOURCE = "missing_source"
    CONTRADICTION = "contradiction"
    NEEDS_UPDATE = "needs_update"
    NEEDS_DELETION = "needs_deletion"


class ReviewActionType(str, Enum):
    """Predefined actions that can be taken on a review item."""

    CREATE_PAGE = "create_page"
    DEEP_RESEARCH = "deep_research"
    SKIP = "skip"
    DELETE_PAGE = "delete_page"
    MERGE_PAGE = "merge_page"


class ReviewStatus(str, Enum):
    """Status of a review item."""

    PENDING = "pending"
    RESOLVED = "resolved"
    DISMISSED = "dismissed"


# ---------------------------------------------------------------------------
# Queue
# ---------------------------------------------------------------------------


class ReviewQueue:
    """Persistent async review queue backed by a JSON file.

    Each review item is a dict with the following keys:

    - ``id`` — unique review item ID (UUID4 hex)
    - ``type`` — :class:`ReviewItemType` value
    - ``severity`` — ``"low"``, ``"medium"``, or ``"high"``
    - ``page`` — page path relative to the wiki root
    - ``description`` — human-readable description of the issue
    - ``suggested_action`` — suggested :class:`ReviewActionType` value
    - ``status`` — :class:`ReviewStatus` value
    - ``created_at`` — ISO-8601 timestamp
    - ``resolved_at`` — ISO-8601 timestamp or ``None``
    - ``action_taken`` — the actual action performed, or ``None``
    - ``note`` — human note attached during resolution or dismissal

    Thread-safety is **not** provided; callers should ensure single-writer
    access or use an external lock.
    """

    QUEUE_FILENAME = "review_queue.json"

    # ------------------------------------------------------------------
    # Initialisation
    # ------------------------------------------------------------------

    def __init__(self, queue_dir: Path) -> None:
        """Initialise the review queue.

        Parameters
        ----------
        queue_dir : Path
            Directory where the queue JSON file is stored (typically
            ``{project}/.llm-wiki/review/``).
        """
        self._queue_dir = queue_dir
        self._queue_dir.mkdir(parents=True, exist_ok=True)
        self._file = self._queue_dir / self.QUEUE_FILENAME
        self._items: dict[str, dict] = {}
        self._load()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def add(self, item: dict) -> str:
        """Add a new review item.

        Parameters
        ----------
        item : dict
            Must contain at least ``type``, ``severity``, ``page``,
            ``description``, and ``suggested_action`` keys.  Any extra
            keys are preserved.

        Returns
        -------
        str
            The unique review item ID.

        Raises
        ------
        ValueError
            If required keys are missing or the action is not one of the
            predefined :class:`ReviewActionType` values.
        """
        required = {"type", "severity", "page", "description", "suggested_action"}
        missing = required - set(item.keys())
        if missing:
            raise ValueError(f"Missing required fields: {missing}")

        # Validate type
        try:
            ReviewItemType(item["type"])
        except ValueError:
            valid = [t.value for t in ReviewItemType]
            raise ValueError(f"Invalid review type: {item['type']!r}. Valid: {valid}")

        # Validate action
        try:
            ReviewActionType(item["suggested_action"])
        except ValueError:
            valid = [a.value for a in ReviewActionType]
            raise ValueError(
                f"Invalid suggested_action: {item['suggested_action']!r}. Valid: {valid}"
            )

        # Validate severity
        if item["severity"] not in ("low", "medium", "high"):
            raise ValueError(
                f"Invalid severity: {item['severity']!r}. Must be low/medium/high"
            )

        review_id = uuid.uuid4().hex
        now = datetime.now(timezone.utc).isoformat()
        entry: dict[str, Any] = {
            "id": review_id,
            "type": item["type"],
            "severity": item["severity"],
            "page": item["page"],
            "description": item["description"],
            "suggested_action": item["suggested_action"],
            "status": ReviewStatus.PENDING.value,
            "created_at": now,
            "resolved_at": None,
            "action_taken": None,
            "note": "",
        }
        # Preserve any extra keys the caller provided
        for k, v in item.items():
            if k not in entry:
                entry[k] = v

        self._items[review_id] = entry
        self._save()
        return review_id

    def list(self, status: str | None = None) -> list[dict]:
        """List all review items, optionally filtered by *status*.

        Parameters
        ----------
        status : str | None
            If provided, only items with this status are returned
            (``"pending"``, ``"resolved"``, or ``"dismissed"``).

        Returns
        -------
        list[dict]
            Review items sorted by creation time (oldest first).
        """
        items = list(self._items.values())
        if status is not None:
            items = [i for i in items if i["status"] == status]
        items.sort(key=lambda i: i["created_at"])
        return items

    def resolve(self, review_id: str, action: str, note: str = "") -> None:
        """Mark a review item as resolved.

        Parameters
        ----------
        review_id : str
            The review item ID.
        action : str
            The action taken (must be a valid :class:`ReviewActionType`).
        note : str
            Optional human-readable note.

        Raises
        ------
        KeyError
            If *review_id* is unknown.
        ValueError
            If *action* is not a valid predefined action, or if the
            item is already dismissed.
        """
        if review_id not in self._items:
            raise KeyError(f"Review item not found: {review_id}")

        item = self._items[review_id]
        if item["status"] == ReviewStatus.DISMISSED.value:
            raise ValueError("Cannot resolve a dismissed review item")

        try:
            ReviewActionType(action)
        except ValueError:
            valid = [a.value for a in ReviewActionType]
            raise ValueError(f"Invalid action: {action!r}. Valid: {valid}")

        item["status"] = ReviewStatus.RESOLVED.value
        item["action_taken"] = action
        item["note"] = note
        item["resolved_at"] = datetime.now(timezone.utc).isoformat()
        self._save()

    def dismiss(self, review_id: str, note: str = "") -> None:
        """Dismiss a review item without taking action.

        Parameters
        ----------
        review_id : str
            The review item ID.
        note : str
            Optional human-readable note explaining why it was dismissed.

        Raises
        ------
        KeyError
            If *review_id* is unknown.
        ValueError
            If the item is already resolved.
        """
        if review_id not in self._items:
            raise KeyError(f"Review item not found: {review_id}")

        item = self._items[review_id]
        if item["status"] == ReviewStatus.RESOLVED.value:
            raise ValueError("Cannot dismiss an already resolved review item")

        item["status"] = ReviewStatus.DISMISSED.value
        item["note"] = note
        item["resolved_at"] = datetime.now(timezone.utc).isoformat()
        self._save()

    def get_stats(self) -> dict:
        """Return aggregate statistics about the review queue.

        Returns
        -------
        dict
            Keys: ``total``, ``pending``, ``resolved``, ``dismissed``.
        """
        total = len(self._items)
        pending = sum(1 for i in self._items.values() if i["status"] == ReviewStatus.PENDING.value)
        resolved = sum(1 for i in self._items.values() if i["status"] == ReviewStatus.RESOLVED.value)
        dismissed = sum(1 for i in self._items.values() if i["status"] == ReviewStatus.DISMISSED.value)
        return {
            "total": total,
            "pending": pending,
            "resolved": resolved,
            "dismissed": dismissed,
        }

    def get_item(self, review_id: str) -> dict | None:
        """Return a single review item by ID, or ``None`` if not found."""
        return self._items.get(review_id)

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def _load(self) -> None:
        """Load review items from the JSON file."""
        if not self._file.is_file():
            self._items = {}
            return
        try:
            data = self._file.read_text(encoding="utf-8")
            items = json.loads(data)
            if not isinstance(items, dict):
                self._items = {}
                return
            self._items = items
        except (json.JSONDecodeError, OSError):
            self._items = {}

    def _save(self) -> None:
        """Persist review items to the JSON file."""
        self._queue_dir.mkdir(parents=True, exist_ok=True)
        tmp = self._file.with_suffix(".tmp")
        tmp.write_text(
            json.dumps(self._items, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        tmp.replace(self._file)
