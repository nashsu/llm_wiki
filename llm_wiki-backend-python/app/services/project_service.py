"""Project lifecycle management service."""

import json
import shutil
import uuid
from datetime import datetime
from pathlib import Path

from app.core.templates import get_template, list_templates
from app.models.config import ProjectConfig
from app.services.config_service import (
    GlobalConfigService,
    ProjectConfigService,
)


class ProjectService:
    """Manages project CRUD operations and template-based project creation.

    All *path* arguments are absolute file-system paths.  The service uses
    :mod:`pathlib` directly so that caller-provided absolute paths are
    respected (the :class:`~app.services.file_service.FileService` class
    cannot be used here because it scopes all paths to a fixed base
    directory).
    """

    def __init__(
        self,
        global_config: GlobalConfigService | None = None,
        project_config: ProjectConfigService | None = None,
    ) -> None:
        self._global_config = global_config or GlobalConfigService()
        self._project_config = project_config or ProjectConfigService()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def create_project(self, name: str, template_id: str, path: str) -> dict:
        """Create a new project at *path* using the specified template.

        Returns a dict with project metadata (``project_id``, ``name``,
        ``path``, ``template``, ``created_at``, ``files``).
        """
        template = get_template(template_id)
        if template is None:
            raise ValueError(f"Unknown template: {template_id!r}")

        project_id = uuid.uuid4().hex
        project_path = Path(path).resolve()
        created_at = datetime.now()

        # 1. Ensure the base project directory exists
        project_path.mkdir(parents=True, exist_ok=True)

        # 2. Create raw/ directories
        (project_path / "raw" / "sources").mkdir(parents=True, exist_ok=True)
        (project_path / "raw" / "assets").mkdir(parents=True, exist_ok=True)

        # 3. Create common wiki/ directories + template-specific extra_dirs
        common_wiki_dirs = ["wiki/entities", "wiki/concepts", "wiki/sources"]
        for sub in common_wiki_dirs + template.extra_dirs:
            (project_path / sub).mkdir(parents=True, exist_ok=True)

        # 4. Write schema.md and purpose.md
        (project_path / "schema.md").write_text(
            template.schema_content, encoding="utf-8"
        )
        (project_path / "purpose.md").write_text(
            template.purpose_content, encoding="utf-8"
        )

        # 5. Write wiki/index.md
        index_content = (
            f"# {template.name} Wiki\n\n"
            f"> {template.description}\n\n"
            "## 目录\n\n"
            "- [[overview|概览]]\n"
            "- [[log|更新日志]]\n"
        )
        (project_path / "wiki" / "index.md").write_text(
            index_content, encoding="utf-8"
        )

        # 6. Write wiki/overview.md
        overview_content = (
            f"# 概览\n\n"
            f"## {template.name} Wiki 概览\n\n"
            "当前 Wiki 处于初始化阶段，内容将在持续摄入和整理中逐步丰富。\n\n"
            "### 使用说明\n\n"
            "- 通过 [[index|索引页]] 浏览所有页面\n"
            "- 通过 [[log|更新日志]] 查看最近变更\n"
            "- 在 `raw/sources/` 中添加源文件以触发内容摄入\n"
        )
        (project_path / "wiki" / "overview.md").write_text(
            overview_content, encoding="utf-8"
        )

        # 7. Write wiki/log.md
        log_content = (
            f"# 更新日志\n\n"
            f"## {created_at.strftime('%Y-%m-%d %H:%M')}\n\n"
            f"- 项目已创建（模板：{template.name}）\n"
            f"- 项目 ID：`{project_id}`\n"
            f"- 初始化 Wiki 目录结构和默认页面\n"
        )
        (project_path / "wiki" / "log.md").write_text(
            log_content, encoding="utf-8"
        )

        # 8. Create .obsidian/ with recommended configuration
        obsidian_dir = project_path / ".obsidian"
        obsidian_dir.mkdir(parents=True, exist_ok=True)
        (obsidian_dir / "app.json").write_text(
            json.dumps(
                {
                    "promptDelete": False,
                    "alwaysUpdateLinks": True,
                    "newFileLocation": "current",
                    "attachmentFolderPath": "raw/assets",
                    "useMarkdownLinks": True,
                    "showUnsupportedFiles": True,
                },
                indent=2,
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        (obsidian_dir / "core-plugins.json").write_text(
            json.dumps(
                {
                    "file-explorer": True,
                    "global-search": True,
                    "switcher": True,
                    "graph": True,
                    "backlink": True,
                    "outgoing-link": True,
                    "tag-pane": True,
                    "page-preview": True,
                    "daily-notes": True,
                    "templates": True,
                    "note-composer": True,
                    "command-palette": True,
                    "editor-status": True,
                    "starred": True,
                    "outline": True,
                    "word-count": True,
                },
                indent=2,
            ),
            encoding="utf-8",
        )

        # 9. Create .llm-wiki/config.json
        config = ProjectConfig(
            project_id=project_id,
            created_at=created_at,
        )
        self._project_config.save(str(project_path), config)

        # 10. Create .llm-wiki/.syncme marker file
        syncme_path = project_path / ".llm-wiki" / ".syncme"
        syncme_path.write_text(
            json.dumps(
                {"project_id": project_id, "created_at": created_at.isoformat()},
                indent=2,
            ),
            encoding="utf-8",
        )

        # 11. Validate directory structure integrity before returning
        created_files = self._gather_created_files(project_path)

        return {
            "project_id": project_id,
            "name": name,
            "path": str(project_path),
            "template": template_id,
            "created_at": created_at.isoformat(),
            "files": created_files,
        }

    def delete_project(self, path: str) -> bool:
        """Delete an entire project directory.

        Returns ``True`` if the directory was removed.
        Raises ``FileNotFoundError`` if the path does not exist or is not
        a valid project.
        """
        if not self.validate_project(path):
            raise FileNotFoundError(f"Not a valid project: {path!r}")

        project_path = Path(path).resolve()
        shutil.rmtree(str(project_path))

        # Clean up recent projects entry
        self._global_config.remove_recent_project(str(project_path))

        return True

    def validate_project(self, path: str) -> bool:
        """Check whether *path* is a valid LLM Wiki project.

        A valid project must contain:
        - ``.llm-wiki/config.json``
        - ``schema.md``
        - ``purpose.md``
        - ``wiki/`` directory
        - ``raw/sources/`` directory
        """
        project_path = Path(path).resolve()
        if not project_path.is_dir():
            return False

        required: list[Path] = [
            project_path / ".llm-wiki" / "config.json",
            project_path / "schema.md",
            project_path / "purpose.md",
            project_path / "wiki",
            project_path / "raw" / "sources",
        ]
        return all(p.exists() for p in required)

    def open_project(self, path: str) -> dict:
        """Open a project and record it in recent / last-project lists.

        Returns the project metadata dict.
        """
        if not self.validate_project(path):
            raise FileNotFoundError(f"Not a valid project: {path!r}")

        project_path = Path(path).resolve()
        name = project_path.name

        # Load project config to get the canonical project_id
        config = self._project_config.load(str(project_path))

        # Update global records
        self._global_config.add_recent_project(str(project_path), name)
        self._global_config.set_last_project(str(project_path), name)

        return {
            "project_id": config.project_id,
            "name": name,
            "path": str(project_path),
            "last_opened": datetime.now().isoformat(),
        }

    def get_recent_projects(self) -> list[dict]:
        """Return the list of recently opened projects."""
        return self._global_config.get_recent_projects()

    def get_last_project(self) -> dict | None:
        """Return the last opened project, or ``None``."""
        return self._global_config.get_last_project()

    def list_templates(self) -> list[dict]:
        """Return all available project templates as dicts."""
        return [t.model_dump() for t in list_templates()]

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _gather_created_files(project_path: Path) -> list[str]:
        """Gather all files created during project initialization."""
        files: list[str] = []
        for p in sorted(project_path.rglob("*")):
            if p.is_file():
                files.append(str(p.relative_to(project_path).as_posix()))
        return files
