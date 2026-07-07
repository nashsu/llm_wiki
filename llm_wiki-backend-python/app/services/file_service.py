"""File system operations service with path traversal protection."""

import mimetypes
import os
import shutil
from pathlib import Path


class FileServiceError(Exception):
    """Base exception for file service errors."""


class PathTraversalError(FileServiceError):
    """Raised when a path attempts to escape the allowed directory."""


class FileNotFound(FileServiceError):
    """Raised when a file or directory is not found."""


class FileAlreadyExists(FileServiceError):
    """Raised when a target path already exists."""


class FileService:
    """Provides file system operations scoped to a base working directory.

    All paths are validated to prevent directory traversal attacks.
    All operations use ``pathlib.Path`` and UTF-8 encoding by default.
    """

    def __init__(self, work_dir: str | Path | None = None) -> None:
        if work_dir is not None:
            self._base_path = Path(work_dir).resolve()
        else:
            self._base_path = None

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _resolve(self, path: str | Path) -> Path:
        """Resolve a user-provided path.

        * If the path is **absolute**, check only for ``..`` traversal.
        * If the path is **relative**, resolve it relative to *base_path*
          (a :class:`PathTraversalError` is raised when no base path is set).

        Raises:
            PathTraversalError: If path traversal is detected via ``..``.
            FileServiceError: If a relative path is given with no base path.
        """
        p = Path(path)

        if p.is_absolute():
            resolved = p.resolve()
            # Check for path traversal via ``..``
            if ".." in str(path) or ".." in str(resolved):
                raise PathTraversalError(
                    f"Path {str(path)!r} escapes the allowed working directory."
                )
            return resolved

        # Relative path mode
        if self._base_path is None:
            raise FileServiceError(
                "Relative paths are not supported when no working directory is set."
            )

        joined = self._base_path.joinpath(path)
        resolved = joined.resolve()
        try:
            resolved.relative_to(self._base_path)
        except ValueError:
            raise PathTraversalError(
                f"Path {str(path)!r} escapes the allowed working directory."
            ) from None
        return resolved

    def _resolve_parent(self, path: str | Path) -> Path:
        """Like :meth:`_resolve` but creates intermediate directories."""
        full = self._resolve(path)
        full.parent.mkdir(parents=True, exist_ok=True)
        return full

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def read_file(self, path: str | Path, encoding: str = "utf-8") -> str:
        """Read a text file and return its contents."""
        full = self._resolve(path)
        if not full.is_file():
            raise FileNotFound(f"File not found: {str(path)!r}")
        return full.read_text(encoding=encoding)

    def read_file_bytes(self, path: str | Path) -> bytes:
        """Read a binary file and return raw bytes."""
        full = self._resolve(path)
        if not full.is_file():
            raise FileNotFound(f"File not found: {str(path)!r}")
        return full.read_bytes()

    def write_file(self, path: str | Path, content: str | bytes) -> None:
        """Write *content* to *path*, creating parent directories as needed."""
        full = self._resolve_parent(path)
        if isinstance(content, str):
            full.write_text(content, encoding="utf-8")
        else:
            full.write_bytes(content)

    def list_directory(self, path: str | Path) -> list[dict]:
        """List directory entries with metadata.

        Returns a list of dicts with keys:
          name, path, is_dir, size, modified
        """
        full = self._resolve(path)
        if not full.is_dir():
            raise FileNotFound(f"Directory not found: {str(path)!r}")

        entries: list[dict] = []
        for child in sorted(full.iterdir()):
            stat = child.stat()
            entries.append(
                {
                    "name": child.name,
                    "path": str(child.as_posix())
                    if self._base_path is None
                    else str(child.relative_to(self._base_path).as_posix()),
                    "is_dir": child.is_dir(),
                    "size": stat.st_size,
                    "modified": stat.st_mtime,
                }
            )
        return entries

    def delete_file(self, path: str | Path) -> None:
        """Delete a single file."""
        full = self._resolve(path)
        if not full.exists():
            raise FileNotFound(f"File not found: {str(path)!r}")
        if not full.is_file():
            raise FileServiceError(f"Not a file: {str(path)!r}")
        full.unlink()

    def delete_directory(self, path: str | Path) -> None:
        """Recursively delete a directory."""
        full = self._resolve(path)
        if not full.exists():
            raise FileNotFound(f"Directory not found: {str(path)!r}")
        if not full.is_dir():
            raise FileServiceError(f"Not a directory: {str(path)!r}")
        shutil.rmtree(str(full))

    def delete(self, path: str | Path) -> None:
        """Delete a file or directory (recursively)."""
        full = self._resolve(path)
        if not full.exists():
            raise FileNotFound(f"Path not found: {str(path)!r}")
        if full.is_dir():
            shutil.rmtree(str(full))
        else:
            full.unlink()

    def rename_file(self, old_path: str | Path, new_path: str | Path) -> None:
        """Rename or move *old_path* to *new_path*.

        Parent directories of *new_path* are created automatically.
        """
        src = self._resolve(old_path)
        if not src.exists():
            raise FileNotFound(f"Source not found: {str(old_path)!r}")

        dst = self._resolve_parent(new_path)
        if dst.exists():
            raise FileAlreadyExists(f"Target already exists: {str(new_path)!r}")

        src.rename(dst)

    def copy_file(self, src_path: str | Path, dst_path: str | Path) -> None:
        """Copy *src_path* to *dst_path*.

        Parent directories of *dst_path* are created automatically.
        """
        src = self._resolve(src_path)
        if not src.exists():
            raise FileNotFound(f"Source not found: {str(src_path)!r}")

        dst = self._resolve_parent(dst_path)
        if dst.exists():
            raise FileAlreadyExists(f"Target already exists: {str(dst_path)!r}")

        shutil.copy2(str(src), str(dst))

    def file_exists(self, path: str | Path) -> bool:
        """Check whether a path exists (file or directory)."""
        full = self._resolve(path)
        return full.exists()

    def get_file_info(self, path: str | Path) -> dict:
        """Return metadata for a file or directory.

        Returns a dict with keys:
          name, path, size, modified, is_dir, mime_type
        """
        full = self._resolve(path)
        if not full.exists():
            raise FileNotFound(f"Path not found: {str(path)!r}")

        stat = full.stat()
        mime_type, _ = mimetypes.guess_type(str(full))

        return {
            "name": full.name,
            "path": str(full.as_posix())
            if self._base_path is None
            else str(full.relative_to(self._base_path).as_posix()),
            "size": stat.st_size,
            "modified": stat.st_mtime,
            "is_dir": full.is_dir(),
            "mime_type": mime_type or "application/octet-stream",
        }

    def ensure_dir(self, path: str | Path) -> None:
        """Ensure a directory exists, creating it if necessary."""
        full = self._resolve(path)
        full.mkdir(parents=True, exist_ok=True)

    @property
    def base_path(self) -> Path | None:
        """Return the resolved base working directory (``None`` if no work_dir was set)."""
        return self._base_path
