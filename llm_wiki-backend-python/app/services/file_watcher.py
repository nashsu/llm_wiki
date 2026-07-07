"""Async file watcher using watchfiles.

Watches a directory for file changes and invokes a callback on
created / modified / deleted events. Ignores common noise directories.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Callable

from watchfiles import Change, awatch

logger = logging.getLogger("llm-wiki")

# Directories to ignore when watching
_IGNORE_DIRS = {".git", "node_modules", ".llm-wiki"}


class FileWatcher:
    """Asynchronous file system watcher for a single directory.

    Usage::

        watcher = FileWatcher(Path("/projects/my-wiki"), my_callback)
        await watcher.start()
        # ... later ...
        await watcher.stop()
    """

    def __init__(
        self,
        watch_dir: Path,
        callback: Callable[[str, Path], None],
    ) -> None:
        self._watch_dir = watch_dir.resolve()
        self._callback = callback
        self._task: asyncio.Task[None] | None = None
        self._stop_event = asyncio.Event()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def start(self) -> None:
        """Start watching *watch_dir* in a background asyncio task.

        Multiple calls are safe — only the first starts the watcher.
        """
        if self._task is not None and not self._task.done():
            logger.warning("Watcher already running for %s", self._watch_dir)
            return

        self._stop_event.clear()
        self._task = asyncio.create_task(self._run())
        logger.info("File watcher started for %s", self._watch_dir)

    async def stop(self) -> None:
        """Stop the watcher and wait for the task to finish."""
        if self._task is None or self._task.done():
            return
        self._stop_event.set()
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        self._task = None
        logger.info("File watcher stopped for %s", self._watch_dir)

    @property
    def is_running(self) -> bool:
        """Whether the watcher is currently active."""
        return self._task is not None and not self._task.done()

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    async def _run(self) -> None:
        """Core watch loop using ``watchfiles.awatch``."""
        try:
            async for changes in awatch(
                str(self._watch_dir),
                stop_event=self._stop_event,
                # watchfiles filter: exclude paths matching these patterns
                watch_filter=None,
            ):
                for change, path_str in changes:
                    path = Path(path_str)
                    if self._should_ignore(path):
                        continue
                    event_type = _change_to_event(change)
                    logger.debug("File event: %s %s", event_type, path)
                    try:
                        self._callback(event_type, path)
                    except Exception:
                        logger.exception(
                            "File watcher callback failed for %s %s",
                            event_type,
                            path,
                        )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception(
                "File watcher error for %s, restarting...", self._watch_dir
            )
            # Re-schedule the watch loop if it fails unexpectedly
            if not self._stop_event.is_set():
                self._task = asyncio.create_task(self._run())

    def _should_ignore(self, path: Path) -> bool:
        """Check whether *path* resides inside an ignored directory."""
        try:
            relative = path.relative_to(self._watch_dir)
        except ValueError:
            return True
        for part in relative.parts:
            if part in _IGNORE_DIRS:
                return True
        return False


def _change_to_event(change: Change) -> str:
    """Map a watchfiles ``Change`` enum to an event type string."""
    mapping = {
        Change.added: "created",
        Change.modified: "modified",
        Change.deleted: "deleted",
    }
    return mapping.get(change, "unknown")
