"""Ingestion worker — processes tasks from the queue via the pipeline.

The worker runs **serially** (one task at a time) to prevent LLM API rate
limiting.  Each task is processed through the cache check and, on a miss,
through the full two-step pipeline (analysis + generation).
"""

import logging
import os
from pathlib import Path
from typing import Any

from app.core.ingest.cache import IngestCache
from app.core.ingest.queue import IngestQueue
from app.core.ingest.pipeline import IngestPipeline

logger = logging.getLogger(__name__)


class IngestWorker:
    """Serial ingestion worker.

    Usage::

        worker = IngestWorker(pipeline, queue, cache)
        result = worker.process_one()   # single task
        results = worker.process_all()  # all pending tasks
    """

    def __init__(
        self,
        pipeline: IngestPipeline,
        queue: IngestQueue,
        cache: IngestCache,
    ) -> None:
        self._pipeline = pipeline
        self._queue = queue
        self._cache = cache
        self._processing = False

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    @property
    def is_processing(self) -> bool:
        """``True`` while the worker is actively processing a task."""
        return self._processing

    def process_one(self) -> dict[str, Any] | None:
        """Dequeue and process a single ingest task.

        Returns a result dictionary, or ``None`` if the queue is empty.

        Result keys
        -----------
        ``task_id``
            The processed task's ID.
        ``source_path``
            Source file path.
        ``status``
            ``"completed"`` | ``"skipped"`` | ``"failed"``
        ``cache_status``
            ``"HIT"`` | ``"MISS"`` (absent on failure).
        ``pages_written``
            List of written wiki pages (present on ``"completed"``).
        ``error``
            Error message (present on ``"failed"``).
        """
        task = self._queue.dequeue()
        if task is None:
            return None

        self._processing = True
        try:
            source_path = task.source_path
            project_path = task.project_path
            source_id = _resolve_source_id(source_path, project_path)

            # --- Read source file -----------------------------------------
            try:
                content = Path(source_path).read_text(encoding="utf-8")
            except FileNotFoundError:
                self._queue.mark_failed(
                    task.id,
                    f"Source file not found: {source_path}",
                )
                return {
                    "task_id": task.id,
                    "source_path": source_path,
                    "status": "failed",
                    "error": f"Source file not found: {source_path}",
                }

            file_stat = os.stat(source_path)
            file_size = file_stat.st_size
            mtime = file_stat.st_mtime

            # --- Cache check ----------------------------------------------
            cache_status = self._cache.check(
                source_id, content, file_size, mtime,
            )

            if cache_status == "HIT":
                logger.info("Cache HIT for %s — skipping", source_id)
                self._queue.mark_complete(task.id)
                return {
                    "task_id": task.id,
                    "source_path": source_path,
                    "status": "skipped",
                    "cache_status": "HIT",
                }

            # --- Pipeline run (cache MISS) --------------------------------
            logger.info("Cache MISS for %s — running pipeline", source_id)
            result = self._pipeline.run(
                source_path=source_path,
                project_path=project_path,
            )

            pages_written = result.get("pages_written", [])

            # --- Update cache & complete task -----------------------------
            self._cache.update(
                source_id=source_id,
                content=content,
                file_size=file_size,
                mtime=mtime,
                files_written=pages_written,
            )
            self._queue.mark_complete(task.id)

            return {
                "task_id": task.id,
                "source_path": source_path,
                "status": "completed",
                "cache_status": "MISS",
                "pages_written": pages_written,
            }

        except Exception as exc:
            logger.exception("Error processing task %s: %s", task.id, exc)
            self._queue.mark_failed(task.id, str(exc))
            return {
                "task_id": task.id,
                "source_path": task.source_path,
                "status": "failed",
                "error": str(exc),
            }
        finally:
            self._processing = False

    def process_all(self) -> list[dict[str, Any]]:
        """Process all pending tasks sequentially.

        Returns a list of result dicts (one per processed task).
        """
        results: list[dict[str, Any]] = []
        while True:
            result = self.process_one()
            if result is None:
                break
            results.append(result)
        return results


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _resolve_source_id(source_path: str, project_path: str) -> str:
    """Derive a POSIX-style relative source identity.

    If *source_path* lies within *project_path* the returned identity is
    the relative path (with forward slashes).  Otherwise just the filename.
    """
    try:
        return str(
            Path(source_path).relative_to(Path(project_path).resolve())
        ).replace("\\", "/")
    except ValueError:
        return Path(source_path).name
