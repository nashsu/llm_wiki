use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const MAX_SKILL_FILE_BYTES: usize = 64_000;
const MAX_SKILL_SCAN_DEPTH: usize = 8;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkill {
    pub name: String,
    pub description: String,
    pub instructions: String,
    pub base_dir: String,
    pub location: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AvailableAgentSkill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub source: String,
}

#[tauri::command]
pub fn agent_list_skills(project_path: String) -> Vec<AvailableAgentSkill> {
    list_available_skills(&project_path)
}

pub fn load_project_skills(project_path: &str, requested: &[String]) -> Vec<AgentSkill> {
    if requested.is_empty() {
        return Vec::new();
    }
    let roots = skill_roots(project_path);
    requested
        .iter()
        .filter_map(|name| normalize_skill_name(name))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter_map(|name| load_one_skill_from_roots(&roots, &name))
        .collect()
}

fn list_available_skills(project_path: &str) -> Vec<AvailableAgentSkill> {
    let mut skills = BTreeMap::<String, AvailableAgentSkill>::new();
    for root in skill_roots(project_path) {
        for candidate in discover_skill_candidates(&root.path) {
            let Some(skill) = load_skill_path(&candidate.path, &candidate.id).ok() else {
                continue;
            };
            // `id` is the path slug used for loading. `name` is display-only
            // metadata from frontmatter and may contain spaces or punctuation.
            // Roots are ordered from most specific to least specific. Keep the
            // first occurrence so project-local skills can override user-level
            // skills with the same id.
            skills
                .entry(candidate.id.clone())
                .or_insert(AvailableAgentSkill {
                    id: candidate.id,
                    name: skill.name,
                    description: skill.description,
                    source: root.source.clone(),
                });
        }
    }
    skills.into_values().collect()
}

#[derive(Debug, Clone)]
struct SkillRoot {
    path: PathBuf,
    source: String,
}

fn skill_roots(project_path: &str) -> Vec<SkillRoot> {
    let mut roots = vec![SkillRoot {
        path: Path::new(project_path).join(".llm-wiki").join("skills"),
        source: "project".to_string(),
    }];
    if let Some(home) = home_dir() {
        roots.push(SkillRoot {
            path: home.join(".claude").join("skills"),
            source: "claude".to_string(),
        });
        roots.push(SkillRoot {
            path: home.join(".codex").join("skills"),
            source: "codex".to_string(),
        });
        roots.push(SkillRoot {
            path: home.join(".agents").join("skills"),
            source: "agents".to_string(),
        });
    }
    roots
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE")
            .or_else(|| {
                let drive = std::env::var_os("HOMEDRIVE")?;
                let path = std::env::var_os("HOMEPATH")?;
                let mut home = PathBuf::from(drive);
                home.push(path);
                Some(home.into_os_string())
            })
            .or_else(|| std::env::var_os("HOME"))
            .map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

fn load_one_skill_from_roots(roots: &[SkillRoot], name: &str) -> Option<AgentSkill> {
    let name = normalize_skill_name(name)?;
    roots
        .iter()
        .find_map(|root| load_one_skill(&root.path, &name))
}

fn load_one_skill(root: &Path, name: &str) -> Option<AgentSkill> {
    let single_file = root.join(format!("{name}.md"));
    if let Ok(skill) = load_skill_file(&single_file, &name) {
        return Some(skill);
    }
    if let Ok(skill) = load_skill_directory(&root.join(name), name) {
        return Some(skill);
    }
    // Skills may be grouped in nested folders. The public id remains the
    // portable directory/file name, while the location in the prompt points to
    // the exact SKILL.md path so the Agent can lazily inspect references.
    discover_skill_candidates(root)
        .into_iter()
        .find(|candidate| candidate.id == name)
        .and_then(|candidate| load_skill_path(&candidate.path, name).ok())
}

#[derive(Debug, Clone)]
struct SkillCandidate {
    id: String,
    path: PathBuf,
}

fn discover_skill_candidates(root: &Path) -> Vec<SkillCandidate> {
    let mut out = Vec::new();
    discover_skill_candidates_inner(root, 0, &mut out);
    out
}

fn discover_skill_candidates_inner(dir: &Path, depth: usize, out: &mut Vec<SkillCandidate>) {
    if depth > MAX_SKILL_SCAN_DEPTH {
        return;
    }
    let Ok(meta) = fs::symlink_metadata(dir) else {
        return;
    };
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut entries = entries.flatten().collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.path());
    for entry in entries {
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_file() {
            if path
                .file_name()
                .and_then(|s| s.to_str())
                .is_some_and(|name| name.eq_ignore_ascii_case("SKILL.md"))
            {
                if let Some(id) = path
                    .parent()
                    .and_then(|parent| parent.file_name())
                    .and_then(|s| s.to_str())
                    .and_then(normalize_skill_name)
                {
                    out.push(SkillCandidate { id, path });
                }
                continue;
            }
            if path
                .extension()
                .and_then(|s| s.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
            {
                if let Some(id) = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .and_then(normalize_skill_name)
                {
                    out.push(SkillCandidate { id, path });
                }
            }
            continue;
        }
        if meta.is_dir() {
            if is_hidden_or_unsafe_skill_dir(&path) {
                continue;
            }
            discover_skill_candidates_inner(&path, depth + 1, out);
        }
    }
}

fn is_hidden_or_unsafe_skill_dir(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or_default();
    name.starts_with('.') || name == "node_modules" || normalize_skill_name(name).is_none()
}

fn load_skill_path(path: &Path, fallback_name: &str) -> Result<AgentSkill, String> {
    if path.file_name().and_then(|s| s.to_str()) == Some("SKILL.md") {
        let dir = path
            .parent()
            .ok_or_else(|| "Skill file has no parent directory".to_string())?;
        return load_skill_directory(dir, fallback_name);
    }
    load_skill_file(&path.to_path_buf(), fallback_name)
}

fn load_skill_file(path: &PathBuf, fallback_name: &str) -> Result<AgentSkill, String> {
    let meta = fs::symlink_metadata(path).map_err(|err| format!("Skill not found: {err}"))?;
    if meta.file_type().is_symlink()
        || !meta.is_file()
        || meta.len() as usize > MAX_SKILL_FILE_BYTES
    {
        return Err("Skill file is not readable or is too large".to_string());
    }
    let raw = fs::read_to_string(path).map_err(|err| format!("Failed to read skill: {err}"))?;
    let (frontmatter, instructions) = split_frontmatter(&raw);
    let name = frontmatter
        .as_deref()
        .and_then(|fm| yaml_string_field(fm, "name"))
        .unwrap_or_else(|| fallback_name.to_string());
    let description = frontmatter
        .as_deref()
        .and_then(|fm| yaml_string_field(fm, "description"))
        .unwrap_or_default();
    if description.trim().is_empty() {
        return Err("Skill description is required".to_string());
    }
    Some(AgentSkill {
        name,
        description,
        instructions: instructions.trim().to_string(),
        base_dir: path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .to_string_lossy()
            .replace('\\', "/"),
        location: path.to_string_lossy().replace('\\', "/"),
    })
    .filter(|skill| !skill.instructions.is_empty())
    .ok_or_else(|| "Skill instructions are empty".to_string())
}

fn load_skill_directory(dir: &Path, fallback_name: &str) -> Result<AgentSkill, String> {
    let meta = fs::symlink_metadata(dir).map_err(|err| format!("Skill folder not found: {err}"))?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err("Skill folder is not readable".to_string());
    }
    let main_path = find_skill_main_file(dir).unwrap_or_else(|| dir.join("SKILL.md"));
    let skill = load_skill_file(&main_path, fallback_name)?;
    // Only SKILL.md is injected into the Agent prompt. Supporting Markdown
    // files stay on disk and should be read lazily after the Agent has chosen
    // to use this skill; this keeps automatic skill availability cheap and
    // avoids flooding ordinary chat turns with unused reference material.
    Ok(skill)
}

fn find_skill_main_file(dir: &Path) -> Option<PathBuf> {
    fs::read_dir(dir)
        .ok()?
        .flatten()
        .find(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.eq_ignore_ascii_case("SKILL.md"))
        })
        .map(|entry| entry.path())
}

fn normalize_skill_name(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains("..")
        || !is_portable_skill_name(trimmed)
    {
        return None;
    }
    Some(trimmed.to_string())
}

fn split_frontmatter(raw: &str) -> (Option<String>, String) {
    let normalized = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let normalized = normalized.replace("\r\n", "\n").replace('\r', "\n");
    if !normalized.starts_with("---\n") {
        return (None, normalized);
    }
    let rest = &normalized[4..];
    if let Some(end) = rest.find("\n---") {
        let fm = rest[..end].to_string();
        let after = rest[end + "\n---".len()..]
            .strip_prefix('\n')
            .unwrap_or(&rest[end + "\n---".len()..])
            .to_string();
        (Some(fm), after)
    } else {
        (None, normalized)
    }
}

fn is_portable_skill_name(value: &str) -> bool {
    if value.ends_with([' ', '.']) {
        return false;
    }
    if value
        .chars()
        .any(|ch| matches!(ch, '<' | '>' | ':' | '"' | '|' | '?' | '*') || ch <= '\u{1f}')
    {
        return false;
    }
    let stem = value
        .split('.')
        .next()
        .unwrap_or(value)
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    !matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

fn yaml_string_field(frontmatter: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}:");
    for line in frontmatter.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with(&prefix) {
            continue;
        }
        let value = trimmed[prefix.len()..].trim();
        let value = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
            .unwrap_or(value);
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use std::fs;
    use uuid::Uuid;

    use super::*;

    #[test]
    fn load_project_skills_reads_frontmatter_skill() {
        let root = std::env::temp_dir().join(format!("llm-wiki-skills-{}", Uuid::new_v4()));
        let skills_dir = root.join(".llm-wiki").join("skills");
        fs::create_dir_all(&skills_dir).unwrap();
        fs::write(
            skills_dir.join("reviewer.md"),
            "---\nname: reviewer\ndescription: Review source quality\n---\nCheck claims carefully.",
        )
        .unwrap();

        let skills = load_project_skills(root.to_str().unwrap(), &["reviewer".to_string()]);
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "reviewer");
        assert_eq!(skills[0].description, "Review source quality");
        assert_eq!(skills[0].instructions, "Check claims carefully.");
        assert!(skills[0].base_dir.ends_with("/.llm-wiki/skills"));
        assert!(skills[0].location.ends_with("/reviewer.md"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn load_project_skills_reads_crlf_frontmatter() {
        let root = std::env::temp_dir().join(format!("llm-wiki-skills-{}", Uuid::new_v4()));
        let skills_dir = root.join(".llm-wiki").join("skills");
        fs::create_dir_all(&skills_dir).unwrap();
        fs::write(
            skills_dir.join("reviewer.md"),
            "---\r\nname: reviewer\r\ndescription: Review source quality\r\n---\r\nCheck claims carefully.",
        )
        .unwrap();

        let skills = load_project_skills(root.to_str().unwrap(), &["reviewer".to_string()]);
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "reviewer");
        assert_eq!(skills[0].description, "Review source quality");
        assert_eq!(skills[0].instructions, "Check claims carefully.");
        assert!(skills[0].base_dir.ends_with("/.llm-wiki/skills"));
        assert!(skills[0].location.ends_with("/reviewer.md"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn load_project_skills_rejects_path_traversal_names() {
        let skills = load_project_skills("/tmp/missing", &["../secret".to_string()]);
        assert!(skills.is_empty());
    }

    #[test]
    fn load_project_skills_rejects_windows_reserved_names() {
        let skills = load_project_skills(
            "/tmp/missing",
            &[
                "con".to_string(),
                "a:b".to_string(),
                "topic.".to_string(),
                "topic ".to_string(),
            ],
        );
        assert!(skills.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn load_project_skills_rejects_symlink_skill_files() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!("llm-wiki-skills-{}", Uuid::new_v4()));
        let skills_dir = root.join(".llm-wiki").join("skills");
        fs::create_dir_all(&skills_dir).unwrap();
        let target = skills_dir.join("target.md");
        fs::write(
            &target,
            "---\nname: target\ndescription: Target skill\n---\nDo not load through a symlink.",
        )
        .unwrap();
        symlink(&target, skills_dir.join("evil.md")).unwrap();

        let loaded = load_project_skills(root.to_str().unwrap(), &["evil".to_string()]);
        assert!(loaded.is_empty());
        let listed = list_available_skills(root.to_str().unwrap());
        assert!(listed.iter().all(|skill| skill.id != "evil"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn oversized_skill_files_are_ignored() {
        let root = std::env::temp_dir().join(format!("llm-wiki-skills-{}", Uuid::new_v4()));
        let skills_dir = root.join(".llm-wiki").join("skills");
        fs::create_dir_all(&skills_dir).unwrap();
        let body = "x".repeat(MAX_SKILL_FILE_BYTES + 1);
        fs::write(
            skills_dir.join("huge.md"),
            format!("---\nname: huge\ndescription: Huge skill\n---\n{body}"),
        )
        .unwrap();

        let listed = list_available_skills(root.to_str().unwrap());
        assert!(listed.iter().all(|skill| skill.id != "huge"));
        let loaded = load_project_skills(root.to_str().unwrap(), &["huge".to_string()]);
        assert!(loaded.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn list_available_skills_reads_markdown_and_skill_folders() {
        let root = std::env::temp_dir().join(format!("llm-wiki-skills-{}", Uuid::new_v4()));
        let skills_dir = root.join(".llm-wiki").join("skills");
        fs::create_dir_all(skills_dir.join("illustrator")).unwrap();
        fs::write(
            skills_dir.join("reviewer.md"),
            "---\nname: reviewer\ndescription: Review source quality\n---\nCheck claims.",
        )
        .unwrap();
        fs::write(
            skills_dir.join("illustrator").join("SKILL.md"),
            "---\nname: illustrator\ndescription: Draw article images\n---\nCreate image prompts.",
        )
        .unwrap();

        let skills = list_available_skills(root.to_str().unwrap());
        let names = skills
            .into_iter()
            .map(|skill| (skill.id, skill.name, skill.source))
            .collect::<Vec<_>>();
        assert!(names.contains(&(
            "reviewer".to_string(),
            "reviewer".to_string(),
            "project".to_string()
        )));
        assert!(names.contains(&(
            "illustrator".to_string(),
            "illustrator".to_string(),
            "project".to_string()
        )));
        let loaded = load_project_skills(root.to_str().unwrap(), &["illustrator".to_string()]);
        assert_eq!(loaded[0].name, "illustrator");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn list_available_skills_accepts_case_insensitive_markdown_names() {
        let root = std::env::temp_dir().join(format!("llm-wiki-skills-{}", Uuid::new_v4()));
        let skills_dir = root.join(".llm-wiki").join("skills");
        fs::create_dir_all(skills_dir.join("designer")).unwrap();
        fs::write(
            skills_dir.join("Reviewer.MD"),
            "---\nname: reviewer\ndescription: Review source quality\n---\nCheck claims.",
        )
        .unwrap();
        fs::write(
            skills_dir.join("designer").join("SKILL.MD"),
            "---\nname: designer\ndescription: Design assets\n---\nCreate image prompts.",
        )
        .unwrap();

        let skills = list_available_skills(root.to_str().unwrap());
        let ids = skills
            .into_iter()
            .map(|skill| skill.id)
            .collect::<BTreeSet<_>>();

        assert!(ids.contains("Reviewer"));
        assert!(ids.contains("designer"));
        let loaded = load_project_skills(root.to_str().unwrap(), &["designer".to_string()]);
        assert_eq!(loaded.len(), 1);
        assert!(loaded[0].location.ends_with("/designer/SKILL.MD"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn nested_skill_folder_is_listed_and_loadable() {
        let root = std::env::temp_dir().join(format!("llm-wiki-skills-{}", Uuid::new_v4()));
        let skill_dir = root
            .join(".llm-wiki")
            .join("skills")
            .join("writing")
            .join("article-illustrator");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: Article Illustrator\ndescription: Draw article images\n---\nUse draw.sh after reading references.",
        )
        .unwrap();

        let skills = list_available_skills(root.to_str().unwrap());
        let article = skills
            .iter()
            .find(|skill| skill.id == "article-illustrator")
            .expect("nested skill should be listed");
        assert_eq!(article.name, "Article Illustrator");

        let loaded = load_project_skills(root.to_str().unwrap(), &[article.id.clone()]);
        assert_eq!(loaded.len(), 1);
        assert!(loaded[0]
            .location
            .ends_with("/writing/article-illustrator/SKILL.md"));
        assert!(loaded[0].instructions.contains("Use draw.sh"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn skills_without_description_are_ignored() {
        let root = std::env::temp_dir().join(format!("llm-wiki-skills-{}", Uuid::new_v4()));
        let skills_dir = root.join(".llm-wiki").join("skills");
        fs::create_dir_all(&skills_dir).unwrap();
        fs::write(
            skills_dir.join("anonymous.md"),
            "---\nname: anonymous\n---\nDo something.",
        )
        .unwrap();

        let listed = list_available_skills(root.to_str().unwrap());
        assert!(listed.iter().all(|skill| skill.id != "anonymous"));
        let loaded = load_project_skills(root.to_str().unwrap(), &["anonymous".to_string()]);
        assert!(loaded.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn load_project_skills_deduplicates_requested_ids() {
        let root = std::env::temp_dir().join(format!("llm-wiki-skills-{}", Uuid::new_v4()));
        let skills_dir = root.join(".llm-wiki").join("skills");
        fs::create_dir_all(&skills_dir).unwrap();
        fs::write(
            skills_dir.join("reviewer.md"),
            "---\nname: reviewer\ndescription: Review source quality\n---\nCheck claims.",
        )
        .unwrap();

        let loaded = load_project_skills(
            root.to_str().unwrap(),
            &["reviewer".to_string(), "reviewer".to_string()],
        );
        assert_eq!(loaded.len(), 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn load_project_skills_reads_only_skill_md_from_skill_folder() {
        let root = std::env::temp_dir().join(format!("llm-wiki-skills-{}", Uuid::new_v4()));
        let skill_dir = root
            .join(".llm-wiki")
            .join("skills")
            .join("article-illustrator");
        fs::create_dir_all(skill_dir.join("references")).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: article-illustrator\ndescription: Draw article images\n---\nUse the bundled scripts when useful.",
        )
        .unwrap();
        fs::write(
            skill_dir.join("references").join("style.md"),
            "# Style\nPrefer editorial illustration.",
        )
        .unwrap();

        let loaded =
            load_project_skills(root.to_str().unwrap(), &["article-illustrator".to_string()]);

        assert_eq!(loaded.len(), 1);
        assert!(loaded[0].instructions.contains("Use the bundled scripts"));
        assert!(!loaded[0].instructions.contains("references/style.md"));
        assert!(!loaded[0]
            .instructions
            .contains("Prefer editorial illustration"));
        assert!(loaded[0]
            .base_dir
            .ends_with("/.llm-wiki/skills/article-illustrator"));
        assert!(loaded[0]
            .location
            .ends_with("/.llm-wiki/skills/article-illustrator/SKILL.md"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn list_available_skills_uses_slug_id_when_frontmatter_name_differs() {
        let root = std::env::temp_dir().join(format!("llm-wiki-skills-{}", Uuid::new_v4()));
        let skills_dir = root.join(".llm-wiki").join("skills");
        fs::create_dir_all(&skills_dir).unwrap();
        fs::write(
            skills_dir.join("article.md"),
            "---\nname: Article Illustrator\ndescription: Draw article images\n---\nCreate image prompts.",
        )
        .unwrap();

        let skills = list_available_skills(root.to_str().unwrap());
        let article = skills
            .iter()
            .find(|skill| skill.id == "article")
            .expect("article skill should be listed");
        assert_eq!(article.name, "Article Illustrator");
        let loaded = load_project_skills(root.to_str().unwrap(), &[article.id.clone()]);
        assert_eq!(loaded[0].name, "Article Illustrator");
        let _ = fs::remove_dir_all(root);
    }
}
