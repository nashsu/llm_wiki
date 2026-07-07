"""Version control service — wraps Git operations via subprocess.

Manages two independent Git repositories:
  - ``wiki/``        — Wiki page content
  - ``raw/sources/`` — Raw source documents
"""

from __future__ import annotations

import logging
import subprocess
import uuid
from datetime import datetime
from pathlib import Path

logger = logging.getLogger("llm-wiki")

# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------


class VersionControlError(Exception):
    """Base exception for version control errors."""


class GitCommandError(VersionControlError):
    """Raised when a git command exits with a non-zero return code."""

    def __init__(self, cmd: list[str], returncode: int, stderr: str) -> None:
        self.cmd = cmd
        self.returncode = returncode
        self.stderr = stderr
        super().__init__(
            f"Git command failed (exit {returncode}): {' '.join(cmd)}\n{stderr}"
        )


class RepoNotFound(VersionControlError):
    """Raised when the target repository directory does not exist."""


# ---------------------------------------------------------------------------
# Scope helpers
# ---------------------------------------------------------------------------

_REPO_SCOPE_PATHS: dict[str, tuple[str, ...]] = {
    "wiki": ("wiki",),
    "raw": ("raw", "sources"),
    "both": (),  # special — caller must handle separately
}


def _scope_to_repo_path(project_path: Path, scope: str) -> Path:
    """Return the git repository path for a given scope."""
    parts = _REPO_SCOPE_PATHS.get(scope)
    if parts is None:
        raise ValueError(f"Unknown scope: {scope!r} (expected 'wiki', 'raw', or 'both')")
    if scope == "both":
        raise ValueError("'both' scope is handled specially, use a concrete scope")
    return project_path.joinpath(*parts)


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------


class VersionControl:
    """Thin wrapper around Git subprocess for an LLM Wiki project.

    The service operates on two independent Git repositories inside the
    project: ``wiki/`` and ``raw/sources/``.

    All public methods accept a ``scope`` parameter that defaults to
    ``"wiki"``.  When ``scope="both"`` the method is executed on **both**
    repositories sequentially (where meaningful).
    """

    GIT_TIMEOUT = 30  # seconds

    def __init__(self, project_path: Path) -> None:
        self._project_path = project_path.resolve()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _git_run(
        self,
        args: list[str],
        scope: str = "wiki",
        *,
        check: bool = True,
    ) -> subprocess.CompletedProcess:
        """Run a git command inside the repository for *scope*.

        Returns:
            ``subprocess.CompletedProcess`` with ``stdout`` and ``stderr``
            decoded as UTF-8.

        Raises:
            RepoNotFound: If the target repo directory does not exist.
            GitCommandError: If the command fails (and ``check=True``).
        """
        repo_path = _scope_to_repo_path(self._project_path, scope)
        if not repo_path.is_dir():
            raise RepoNotFound(
                f"Repository directory does not exist: {repo_path}"
            )

        cmd = ["git"] + args
        logger.debug("Running: git %s (cwd=%s)", " ".join(args), repo_path)

        try:
            result = subprocess.run(
                cmd,
                cwd=str(repo_path),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=self.GIT_TIMEOUT,
            )
        except subprocess.TimeoutExpired:
            raise GitCommandError(cmd, -1, "Command timed out") from None

        if check and result.returncode != 0:
            raise GitCommandError(cmd, result.returncode, result.stderr.strip())

        return result

    def _both_scopes(self, scope: str) -> list[str]:
        """Return a list of scopes to operate on."""
        if scope == "both":
            return ["wiki", "raw"]
        return [scope]

    # ------------------------------------------------------------------
    # Repository initialisation
    # ------------------------------------------------------------------

    def init(self, scope: str = "both") -> dict[str, str]:
        """Initialise Git repositories if they are not yet initialised.

        Returns a dict mapping scope → status message.
        """
        results: dict[str, str] = {}
        for s in self._both_scopes(scope):
            repo_path = _scope_to_repo_path(self._project_path, s)
            repo_path.mkdir(parents=True, exist_ok=True)

            git_dir = repo_path / ".git"
            if git_dir.is_dir():
                results[s] = "already initialised"
                continue

            self._git_run(["init"], scope=s, check=True)
            self._git_run(["config", "user.name", "LLM Wiki"], scope=s, check=True)
            self._git_run(
                ["config", "user.email", "wiki@llm-wiki.local"],
                scope=s,
                check=True,
            )
            results[s] = "initialised"
            logger.info("Git repo initialised: %s", repo_path)

        return results

    # ------------------------------------------------------------------
    # Snapshots
    # ------------------------------------------------------------------

    def create_snapshot(
        self, name: str, scope: str = "wiki"
    ) -> dict[str, str]:
        """Create a snapshot (commit) in the specified repo.

        The *name* is automatically prefixed (e.g. ``manual-{name}``).
        If no name is provided, a UUID-based name is generated.

        Returns a dict mapping scope → commit hash.
        """
        formatted_name = self._format_snapshot_name(name)
        results: dict[str, str] = {}

        for s in self._both_scopes(scope):
            self._git_run(["add", "-A"], scope=s, check=True)
            result = self._git_run(
                ["commit", "-m", formatted_name],
                scope=s,
                check=False,
            )
            if result.returncode == 0:
                # Extract commit hash from "commit <hash>\n..."
                commit_hash = result.stdout.strip().split("\n")[0]
                # Typical output: "[master (root-commit) abc1234] msg"
                # We can use rev-parse for reliability
                rev_result = self._git_run(
                    ["rev-parse", "HEAD"], scope=s, check=True
                )
                results[s] = rev_result.stdout.strip()
            elif "nothing to commit" in (result.stderr + result.stdout):
                results[s] = "no changes"
            else:
                raise GitCommandError(
                    ["git", "commit", "-m", formatted_name],
                    result.returncode,
                    result.stderr.strip(),
                )

        return results

    @staticmethod
    def _format_snapshot_name(name: str) -> str:
        """Apply automatic naming prefix based on the *name* pattern."""
        if not name:
            return f"manual-{uuid.uuid4().hex[:8]}"

        # If name already carries a known prefix, use it as-is
        known_prefixes = ("pre-ingest-", "post-ingest-", "manual-", "auto-")
        if any(name.startswith(p) for p in known_prefixes):
            return name

        return f"manual-{name}"

    def list_snapshots(self, scope: str = "wiki") -> dict[str, list[dict]]:
        """List snapshots (commits) in the specified repo.

        Returns a dict mapping scope → list of snapshot dicts with keys
        ``hash``, ``message``, ``date``, ``author``.
        """
        results: dict[str, list[dict]] = {}
        for s in self._both_scopes(scope):
            try:
                raw = self._git_run(
                    [
                        "log",
                        "--oneline",
                        "--format=%H|||%s|||%ai|||%an",
                        "--max-count=100",
                    ],
                    scope=s,
                    check=True,
                )
            except GitCommandError as exc:
                if "does not have any commits" in exc.stderr:
                    results[s] = []
                    continue
                if "fatal: not a git repository" in exc.stderr:
                    results[s] = []
                    continue
                raise

            snapshots: list[dict] = []
            for line in raw.stdout.strip().split("\n"):
                if not line.strip():
                    continue
                parts = line.split("|||", 3)
                if len(parts) == 4:
                    snapshots.append({
                        "hash": parts[0],
                        "message": parts[1],
                        "date": parts[2],
                        "author": parts[3],
                    })

            results[s] = snapshots

        return results

    def get_snapshot_diff(
        self, snapshot_id: str, scope: str = "wiki"
    ) -> dict[str, dict]:
        """Show diff summary between *snapshot_id* and HEAD.

        Returns a dict mapping scope → diff info.
        """
        results: dict[str, dict] = {}
        for s in self._both_scopes(scope):
            try:
                # --stat output
                stat_result = self._git_run(
                    ["diff", f"{snapshot_id}..HEAD", "--stat"],
                    scope=s,
                    check=True,
                )
                # Number of files changed
                num_result = self._git_run(
                    ["diff", f"{snapshot_id}..HEAD", "--stat"],
                    scope=s,
                    check=True,
                )
            except GitCommandError as exc:
                if "bad revision" in exc.stderr.lower():
                    raise VersionControlError(
                        f"Invalid snapshot ID: {snapshot_id}"
                    ) from exc
                raise

            # Parse --stat output for files, additions, deletions
            stat_lines = stat_result.stdout.strip().split("\n")
            files_changed = 0
            additions = 0
            deletions = 0
            file_list: list[str] = []

            for line in stat_lines:
                line = line.strip()
                if not line:
                    continue
                # Lines look like:
                #  file.py | 10 +++++-----
                #  1 file changed, 5 insertions(+), 3 deletions(-)
                if "file changed" in line or "files changed" in line:
                    # Summary line: "N files changed, A insertions(+), D deletions(-)"
                    import re

                    m = re.search(
                        r"(\d+) files? changed", line
                    )
                    if m:
                        files_changed = int(m.group(1))
                    m = re.search(r"(\d+) insertion", line)
                    if m:
                        additions += int(m.group(1))
                    m = re.search(r"(\d+) deletion", line)
                    if m:
                        deletions += int(m.group(1))
                elif " | " in line:
                    file_list.append(line.split(" | ")[0].strip())

            results[s] = {
                "files_changed": files_changed,
                "additions": additions,
                "deletions": deletions,
                "files": file_list,
                "stat_output": stat_result.stdout.strip(),
            }

        return results

    # ------------------------------------------------------------------
    # Rollback
    # ------------------------------------------------------------------

    def rollback(
        self,
        snapshot_id: str,
        scope: str = "wiki",
        create_branch: bool = True,
    ) -> dict[str, dict]:
        """Roll back the repository to *snapshot_id*.

        If *create_branch* is ``True`` (default), a new branch is created
        before the hard reset so that the current state is not lost.

        Returns a dict mapping scope → rollback info.
        """
        results: dict[str, dict] = {}
        for s in self._both_scopes(scope):
            branch_name: str | None = None
            if create_branch:
                ts = datetime.now().strftime("%Y%m%d%H%M%S")
                branch_name = f"rollback-{snapshot_id[:8]}-{ts}"
                self._git_run(
                    ["checkout", "-b", branch_name],
                    scope=s,
                    check=True,
                )

            self._git_run(
                ["reset", "--hard", snapshot_id],
                scope=s,
                check=True,
            )

            info: dict = {
                "rolled_back_to": snapshot_id,
                "branch_created": branch_name,
            }
            results[s] = info

        return results

    # ------------------------------------------------------------------
    # Branch management
    # ------------------------------------------------------------------

    def create_branch(self, name: str, scope: str = "wiki") -> dict[str, str]:
        """Create a new branch.

        Returns a dict mapping scope → branch name.
        """
        results: dict[str, str] = {}
        for s in self._both_scopes(scope):
            self._git_run(["checkout", "-b", name], scope=s, check=True)
            results[s] = name
        return results

    def list_branches(self, scope: str = "wiki") -> dict[str, list[str]]:
        """List all branches.

        Returns a dict mapping scope → list of branch names.
        """
        results: dict[str, list[str]] = {}
        for s in self._both_scopes(scope):
            try:
                raw = self._git_run(
                    ["branch", "-a"], scope=s, check=True
                )
            except RepoNotFound:
                results[s] = []
                continue

            branches = [
                line.strip().replace("* ", "").strip()
                for line in raw.stdout.strip().split("\n")
                if line.strip()
            ]
            results[s] = branches

        return results

    def switch_branch(self, name: str, scope: str = "wiki") -> dict[str, str]:
        """Switch to an existing branch.

        Returns a dict mapping scope → branch name.
        """
        results: dict[str, str] = {}
        for s in self._both_scopes(scope):
            self._git_run(["checkout", name], scope=s, check=True)
            results[s] = name
        return results

    def delete_branch(self, name: str, scope: str = "wiki") -> dict[str, str]:
        """Delete a branch.

        Returns a dict mapping scope → branch name.
        """
        results: dict[str, str] = {}
        for s in self._both_scopes(scope):
            self._git_run(["branch", "-D", name], scope=s, check=True)
            results[s] = name
        return results

    # ------------------------------------------------------------------
    # Status
    # ------------------------------------------------------------------

    def get_status(self, scope: str = "wiki") -> dict[str, dict]:
        """Get the current working tree status.

        Returns a dict mapping scope → status info with keys:
        ``porcelain``, ``branch``, ``clean``.
        """
        results: dict[str, dict] = {}
        for s in self._both_scopes(scope):
            try:
                porcelain = self._git_run(
                    ["status", "--porcelain"], scope=s, check=True
                )
            except GitCommandError as exc:
                if "not a git repository" in exc.stderr:
                    results[s] = {
                        "porcelain": "",
                        "branch": None,
                        "clean": True,
                    }
                    continue
                raise

            # Determine branch name -- rev-parse fails when there are no
            # commits yet, which is perfectly valid for a new repo.
            branch: str | None = None
            try:
                branch_result = self._git_run(
                    ["rev-parse", "--abbrev-ref", "HEAD"],
                    scope=s,
                    check=True,
                )
                branch = branch_result.stdout.strip()
            except GitCommandError:
                branch = None

            output = porcelain.stdout.strip()
            results[s] = {
                "porcelain": output,
                "branch": branch,
                "clean": len(output) == 0,
            }

        return results
