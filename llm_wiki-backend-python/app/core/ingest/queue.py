"""Persistent ingestion queue backed by a single JSON file.

Tasks are serialised to ``queue.json`` so that the queue survives application
restarts (crash recovery).  All processing is serial — no concurrency — to
prevent LLM API rate limiting.
"""

import json
import logging
import time
import uuid
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Task model
# ---------------------------------------------------------------------------


@dataclass
class QueueTask:
    """A single ingestion task."""

    id: str
    source_path: str
    project_path: str
    status: str = "pending"  # pending | processing | completed | failed | cancelled
    created_at: float = 0.0
    attempts: int = 0
    max_attempts: int = 3
    error: str | None = None


# ---------------------------------------------------------------------------
# Queue
# ---------------------------------------------------------------------------


class IngestQueue:
    """Persistent ingestion queue backed by ``queue.json``.

    Queue location: ``{queue_dir}/queue.json``

    Usage::

        queue = IngestQueue(".llm-wiki/queue")
        task_id = queue.enqueue("/path/to/doc.pdf", "/path/to/project")
        task = queue.dequeue()
        # ... process ...
        queue.mark_complete(task.id)
    """

    QUEUE_FILE = "queue.json"

    def __init__(self, queue_dir: str | Path) -> None:
        self._queue_dir = Path(queue_dir)
        self._queue_dir.mkdir(parents=True, exist_ok=True)
        self._queue_file = self._queue_dir / self.QUEUE_FILE
        self._tasks: dict[str, dict[str, Any]] = {}
        self._load()

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def _load(self) -> None:
        """Load tasks from ``queue.json`` on disk."""
        if self._queue_file.exists():
            try:
                data = json.loads(self._queue_file.read_text(encoding="utf-8"))
                self._tasks = data if isinstance(data, dict) else {}
                logger.debug("Loaded queue with %d tasks", len(self._tasks))
            except (json.JSONDecodeError, OSError) as exc:
                logger.warning("Failed to load queue, starting fresh: %s", exc)
                self._tasks = {}

    def _save(self) -> None:
        """Write queue to disk atomically (tmp + rename)."""
        tmp = self._queue_file.with_suffix(".tmp")
        try:
            tmp.write_text(
                json.dumps(self._tasks, indent=2, ensure_ascii=False),
                encoding="utf-8",
            )
            tmp.replace(self._queue_file)
        except OSError as exc:
            logger.error("Failed to save queue: %s", exc)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def enqueue(self, source_path: str, project_path: str) -> str:
        """Add a single ingestion task.

        Returns the newly created task ID (UUID4).
        """
        task_id = str(uuid.uuid4())
        task = QueueTask(
            id=task_id,
            source_path=source_path,
            project_path=project_path,
            status="pending",
            created_at=time.time(),
        )
        self._tasks[task_id] = asdict(task)
        self._save()
        logger.info("Enqueued task %s for %s", task_id, source_path)
        return task_id

    def enqueue_batch(self, sources: list[tuple[str, str]]) -> list[str]:
        """Add multiple tasks at once.

        Each tuple is ``(source_path, project_path)``.
        Returns a list of task IDs (same order as *sources*).
        """
        task_ids: list[str] = []
        for source_path, project_path in sources:
            task_id = self.enqueue(source_path, project_path)
            task_ids.append(task_id)
        return task_ids

    def dequeue(self) -> QueueTask | None:
        """Claim the next pending task (FIFO order).

        The task is atomically moved from ``pending`` to ``processing``
        state so that a concurrent crash does not lose it.
        Returns ``None`` when there are no pending tasks.
        """
        pending = [
            t for t in self._tasks.values() if t["status"] == "pending"
        ]
        if not pending:
            return None

        # FIFO
        pending.sort(key=lambda t: t["created_at"])
        task_data = pending[0]
        task_data["status"] = "processing"
        self._save()

        return QueueTask(**task_data)

    def mark_complete(self, task_id: str) -> None:
        """Mark a task as completed and remove it from the queue."""
        if task_id in self._tasks:
            del self._tasks[task_id]
            self._save()
            logger.info("Task %s completed", task_id)

    def mark_failed(self, task_id: str, error: str) -> None:
        """Mark a task as failed.

        If the task has not exhausted its retry limit, it is reset to
        ``pending`` for automatic retry.  Otherwise it stays ``failed``.
        """
        task = self._tasks.get(task_id)
        if task is None:
            logger.warning("Cannot mark unknown task %s as failed", task_id)
            return

        task["attempts"] = task.get("attempts", 0) + 1
        task["error"] = error

        if task["attempts"] >= task.get("max_attempts", 3):
            task["status"] = "failed"
            logger.warning(
                "Task %s failed after %d attempt(s): %s",
                task_id,
                task["attempts"],
                error,
            )
        else:
            task["status"] = "pending"
            logger.info(
                "Task %s failed (attempt %d/%d), will retry: %s",
                task_id,
                task["attempts"],
                task.get("max_attempts", 3),
                error,
            )
        self._save()

    def get_status(self, task_id: str) -> dict[str, Any]:
        """Return a snapshot of a task's current state.

        If the task is unknown the returned dict will have
        ``{"id": task_id, "status": "not_found"}``.
        """
        task = self._tasks.get(task_id)
        if task is None:
            return {"id": task_id, "status": "not_found"}
        return dict(task)

    def list_tasks(
        self,
        status: str | None = None,
    ) -> list[dict[str, Any]]:
        """Return all tasks, optionally filtered by *status*.

        Results are sorted by ``created_at`` (oldest first).
        """
        tasks = list(self._tasks.values())
        if status is not None:
            tasks = [t for t in tasks if t["status"] == status]
        return sorted(tasks, key=lambda t: t.get("created_at", 0))

    def cancel(self, task_id: str) -> None:
        """Cancel a pending or processing task."""
        task = self._tasks.get(task_id)
        if task is None:
            logger.warning("Cannot cancel unknown task %s", task_id)
            return

        if task["status"] in ("pending", "processing"):
            task["status"] = "cancelled"
            self._save()
            logger.info("Task %s cancelled", task_id)

    def retry(self, task_id: str) -> None:
        """Reset a failed task to ``pending`` so it can be retried."""
        task = self._tasks.get(task_id)
        if task is None:
            logger.warning("Cannot retry unknown task %s", task_id)
            return

        task["status"] = "pending"
        task["attempts"] = 0
        task["error"] = None
        self._save()
        logger.info("Task %s reset for retry", task_id)

    # ------------------------------------------------------------------
    # Convenience properties
    # ------------------------------------------------------------------

    @property
    def pending_count(self) -> int:
        return sum(1 for t in self._tasks.values() if t["status"] == "pending")

    @property
    def failed_count(self) -> int:
        return sum(1 for t in self._tasks.values() if t["status"] == "failed")
