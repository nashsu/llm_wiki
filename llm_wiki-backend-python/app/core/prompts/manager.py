"""PromptManager - load and render prompt templates with Jinja2."""

from pathlib import Path

from jinja2 import Template


class PromptManager:
    """Manages loading and rendering of prompt templates.

    Templates are Markdown files with Jinja2 ``{{ variable }}`` placeholders.
    Builtin templates reside in ``app/core/prompts/``.  Optionally, a project
    can override them by placing files in ``.llm-wiki/prompt/`` under the
    project root.  Custom templates take precedence over builtin ones.
    """

    BUILTIN_PROMPT_DIR: Path = Path(__file__).resolve().parent

    def __init__(self, project_path: Path | None = None) -> None:
        """Initialise the prompt manager.

        Parameters
        ----------
        project_path : Path | None
            If given, ``{project_path}/.llm-wiki/prompt/`` is searched before
            builtin templates.
        """
        self._custom_dir: Path | None = None
        if project_path is not None:
            self._custom_dir = project_path.resolve() / ".llm-wiki" / "prompt"

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def load(self, name: str) -> str:
        """Load the raw text of a prompt template.

        Resolution order:
        1. Custom directory (if configured and the file exists).
        2. Builtin directory.

        Parameters
        ----------
        name : str
            Template name (without ``.md`` suffix).

        Returns
        -------
        str
            Raw template text (UTF-8).

        Raises
        ------
        FileNotFoundError
            If the template cannot be found in either location.
        """
        # 1. Custom overrides
        if self._custom_dir is not None:
            custom_path = self._custom_dir / f"{name}.md"
            if custom_path.is_file():
                return custom_path.read_text(encoding="utf-8")

        # 2. Builtin
        builtin_path = self.get_builtin_path(name)
        if builtin_path.is_file():
            return builtin_path.read_text(encoding="utf-8")

        raise FileNotFoundError(f"Prompt '{name}' not found")

    def render(self, template_name: str, **variables: str) -> str:
        """Load a template and render it with the given variables.

        Parameters
        ----------
        template_name : str
            Template name (without ``.md`` suffix).
        **variables : str
            Jinja2 template variables.

        Returns
        -------
        str
            Rendered prompt text.
        """
        template_text = self.load(template_name)
        template = Template(template_text)
        return template.render(**variables)

    def list_available(self) -> list[str]:
        """Return sorted list of all available prompt names.

        Scans both the builtin directory and the custom directory (if
        configured and existing).
        """
        names: set[str] = set()

        if self.BUILTIN_PROMPT_DIR.is_dir():
            for f in self.BUILTIN_PROMPT_DIR.iterdir():
                if f.suffix == ".md" and f.stem != "__init__":
                    names.add(f.stem)

        if self._custom_dir is not None and self._custom_dir.is_dir():
            for f in self._custom_dir.iterdir():
                if f.suffix == ".md":
                    names.add(f.stem)

        return sorted(names)

    def get_builtin_path(self, name: str) -> Path:
        """Return the absolute path of a builtin template file.

        Parameters
        ----------
        name : str
            Template name (without ``.md`` suffix).

        Returns
        -------
        Path
        """
        return self.BUILTIN_PROMPT_DIR / f"{name}.md"
