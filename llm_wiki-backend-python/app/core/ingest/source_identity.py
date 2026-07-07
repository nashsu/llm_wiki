"""Source identity helper — generate a human-readable identifier for a source file."""

from pathlib import Path


def get_source_identity(source_path: str, project_path: str) -> str:
    """Generate a source identity string from a file path relative to the project.

    The identity is a POSIX-style relative path (e.g. ``raw/sources/paper.pdf``).
    If *source_path* does not sit under *project_path*, the bare filename is
    returned as a fallback.

    Parameters
    ----------
    source_path : str
        Absolute or relative path to the source file.
    project_path : str
        Absolute path to the project root.

    Returns
    -------
    str
        POSIX-style relative path suitable for use in frontmatter and logs.
    """
    try:
        rel = Path(source_path).resolve().relative_to(Path(project_path).resolve())
    except ValueError:
        # Source is outside the project — just use the filename
        return Path(source_path).name
    return rel.as_posix()
