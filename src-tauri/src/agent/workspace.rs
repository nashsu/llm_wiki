use std::path::{Path, PathBuf};

// Public, user-visible directory for files produced by the backend Agent,
// skills, shell commands, and future non-UI generation tools. Keep this name
// non-hidden so users can find generated HTML/images/scripts without digging
// through app metadata folders.
pub const AGENT_WORKSPACE_DIR: &str = "agent-workspace";

pub fn agent_workspace_path(project_path: impl AsRef<Path>) -> PathBuf {
    project_path.as_ref().join(AGENT_WORKSPACE_DIR)
}

pub fn agent_workspace_display(project_path: impl AsRef<Path>) -> String {
    agent_workspace_path(project_path)
        .to_string_lossy()
        .replace('\\', "/")
}
