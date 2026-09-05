use std::fs;
use std::io::Write;
use std::path::Path;

use chrono::Local;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::panic_guard::run_guarded;
use crate::types::wiki::WikiProject;

#[tauri::command]
pub fn create_project(name: String, path: String) -> Result<WikiProject, String> {
    run_guarded("create_project", || create_project_impl(name, path))
}

fn create_project_impl(name: String, path: String) -> Result<WikiProject, String> {
    let root = Path::new(&path).join(&name);

    if root.exists() {
        return Err(format!("Directory already exists: '{}'", root.display()));
    }

    // Create all required subdirectories
    let dirs = [
        "raw/sources",
        "raw/assets",
        "wiki/entities",
        "wiki/concepts",
        "wiki/sources",
        "wiki/queries",
        "wiki/comparisons",
        "wiki/synthesis",
    ];
    for dir in &dirs {
        fs::create_dir_all(root.join(dir))
            .map_err(|e| format!("Failed to create directory '{}': {}", dir, e))?;
    }

    let today = Local::now().format("%Y-%m-%d").to_string();

    // schema.md
    let schema_content = format!(
        r#"# Wiki Schema

## Page Types

| Type | Directory | Purpose |
|------|-----------|---------|
| entity | wiki/entities/ | Named things (models, companies, people, datasets) |
| concept | wiki/concepts/ | Ideas, techniques, phenomena |
| source | wiki/sources/ | Papers, articles, talks, blog posts |
| query | wiki/queries/ | Open questions under investigation |
| comparison | wiki/comparisons/ | Side-by-side analysis of related entities |
| synthesis | wiki/synthesis/ | Cross-cutting summaries and conclusions |

## Naming Conventions

- Files: `kebab-case.md`
- Entities: match official name where possible (e.g., `gpt-4.md`, `openai.md`)
- Concepts: descriptive noun phrases (e.g., `chain-of-thought.md`)
- Sources: `author-year-slug.md` (e.g., `wei-2022-chain-of-thought.md`)
- Queries: question as slug (e.g., `does-scale-improve-reasoning.md`)

## Frontmatter

All pages must include YAML frontmatter:

```yaml
---
type: entity | concept | source | query | comparison | synthesis | overview
title: Human-readable title
tags: []
related: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
---
```

Source pages also include:
```yaml
authors: []
year: YYYY
url: ""
venue: ""
```

## Index Format

`wiki/index.md` lists all pages grouped by type. Each entry:
```
- [[page-slug]] — one-line description
```

## Log Format

`wiki/log.md` records research activity in reverse chronological order:
```
## YYYY-MM-DD

- Action taken / finding noted
```

## Cross-referencing Rules

- Use `[[page-slug]]` syntax to link between wiki pages
- Every entity and concept should appear in `wiki/index.md`
- Queries link to the sources and concepts they draw on
- Synthesis pages cite all contributing sources via `related:`

## Contradiction Handling

When sources contradict each other:
1. Note the contradiction in the relevant concept or entity page
2. Create or update a query page to track the open question
3. Link both sources from the query page
4. Resolve in a synthesis page once sufficient evidence exists
"#
    );
    write_file_inner(root.join("schema.md"), &schema_content)?;

    // purpose.md
    let purpose_content = r#"# Project Purpose

## Goal

<!-- What are you trying to understand or build? -->

## Key Questions

<!-- List the primary questions driving this research -->

1.
2.
3.

## Scope

<!-- What is in scope? What is explicitly out of scope? -->

**In scope:**
-

**Out of scope:**
-

## Thesis

<!-- Your current working hypothesis or conclusion (update as research progresses) -->

> TBD
"#;
    write_file_inner(root.join("purpose.md"), purpose_content)?;

    // wiki/index.md
    let index_content = r#"# Wiki Index

## Entities

## Concepts

## Sources

## Queries

## Comparisons

## Synthesis
"#;
    write_file_inner(root.join("wiki/index.md"), index_content)?;

    // wiki/log.md
    let log_content = format!(
        r#"# Research Log

## {today}

- Project created
"#
    );
    write_file_inner(root.join("wiki/log.md"), &log_content)?;

    // wiki/overview.md
    let overview_content = r#"---
type: overview
title: Project Overview
tags: []
related: []
---

# Overview

<!-- Provide a high-level summary of what this wiki covers and its current state. Update regularly as understanding deepens. -->
"#;
    write_file_inner(root.join("wiki/overview.md"), overview_content)?;

    // .obsidian config for Obsidian compatibility
    fs::create_dir_all(root.join(".obsidian"))
        .map_err(|e| format!("Failed to create .obsidian: {}", e))?;

    // Obsidian app config: set attachment folder, exclude hidden dirs
    let obsidian_app_config = r#"{
  "attachmentFolderPath": "raw/assets",
  "userIgnoreFilters": [
    ".cache",
    ".llm-wiki",
    ".superpowers"
  ],
  "useMarkdownLinks": false,
  "newLinkFormat": "shortest",
  "showUnsupportedFiles": false
}"#;
    write_file_inner(root.join(".obsidian/app.json"), obsidian_app_config)?;

    // Obsidian appearance: dark mode
    let obsidian_appearance = r#"{
  "baseFontSize": 16,
  "theme": "obsidian"
}"#;
    write_file_inner(root.join(".obsidian/appearance.json"), obsidian_appearance)?;

    // Enable graph view and backlinks core plugins
    let obsidian_core_plugins = r#"{
  "file-explorer": true,
  "global-search": true,
  "graph": true,
  "backlink": true,
  "tag-pane": true,
  "page-preview": true,
  "outgoing-link": true,
  "starred": true
}"#;
    write_file_inner(
        root.join(".obsidian/core-plugins.json"),
        obsidian_core_plugins,
    )?;

    Ok(WikiProject {
        name,
        // Forward slashes for cross-platform consistency in the TS layer.
        path: root.to_string_lossy().replace('\\', "/"),
    })
}

#[tauri::command]
pub fn open_project(path: String) -> Result<WikiProject, String> {
    run_guarded("open_project", || {
        let root = Path::new(&path);

        if root.is_dir()
            && root.join(".obsidian").is_dir()
            && (!root.join("schema.md").is_file() || !root.join("wiki").is_dir())
        {
            initialize_existing_obsidian_vault(root)?;
        }
        validate_wiki_project_root(root)?;

        // Derive project name from the directory name
        let name = root
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("Unknown")
            .to_string();

        Ok(WikiProject {
            name,
            // Forward slashes for cross-platform consistency in the TS layer.
            path: path.replace('\\', "/"),
        })
    })
}

/// Add only LLM Wiki-managed scaffolding to an existing Obsidian vault.
/// Existing notes, attachments, settings and unknown files are never moved or
/// overwritten. In particular, `.obsidian/` remains entirely Obsidian-owned.
fn initialize_existing_obsidian_vault(root: &Path) -> Result<(), String> {
    let root_metadata =
        fs::symlink_metadata(root).map_err(|e| format!("Failed to inspect vault root: {e}"))?;
    if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
        return Err("Vault root must be a real directory, not a symlink".to_string());
    }
    let obsidian = fs::symlink_metadata(root.join(".obsidian"))
        .map_err(|e| format!("Failed to inspect .obsidian: {e}"))?;
    if !obsidian.is_dir() || obsidian.file_type().is_symlink() {
        return Err(".obsidian must be a real directory inside the selected vault".to_string());
    }

    for dir in [
        "raw/sources",
        "raw/assets",
        "wiki/entities",
        "wiki/concepts",
        "wiki/sources",
        "wiki/queries",
        "wiki/comparisons",
        "wiki/synthesis",
    ] {
        create_managed_directory(root, dir)?;
    }

    write_file_if_missing(
        &root.join("schema.md"),
        "# Wiki Schema\n\nLLM Wiki-managed pages live under `wiki/`. Existing vault notes remain in place.\n",
    )?;
    write_file_if_missing(
        &root.join("purpose.md"),
        "# Project Purpose\n\nDescribe the goal and scope of this knowledge base.\n",
    )?;
    write_file_if_missing(&root.join("wiki/index.md"), "# Wiki Index\n")?;
    write_file_if_missing(&root.join("wiki/log.md"), "# Research Log\n")?;
    write_file_if_missing(
        &root.join("wiki/overview.md"),
        "---\ntype: overview\ntitle: Project Overview\ntags: []\nrelated: []\n---\n\n# Overview\n",
    )?;
    Ok(())
}

fn create_managed_directory(root: &Path, relative: &str) -> Result<(), String> {
    let mut current = root.to_path_buf();
    for component in Path::new(relative).components() {
        let std::path::Component::Normal(name) = component else {
            return Err(format!("Invalid managed directory path: '{relative}'"));
        };
        current.push(name);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => {
                return Err(format!(
                    "Refusing unsafe managed directory '{}': expected a real directory",
                    current.display()
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(|error| {
                    format!(
                        "Failed to create managed directory '{}': {error}",
                        current.display()
                    )
                })?;
            }
            Err(error) => {
                return Err(format!(
                    "Failed to inspect managed directory '{}': {error}",
                    current.display()
                ));
            }
        }
    }
    Ok(())
}

fn write_file_if_missing(path: &Path, contents: &str) -> Result<(), String> {
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(mut file) => file
            .write_all(contents.as_bytes())
            .map_err(|e| format!("Failed to initialize '{}': {e}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let metadata = fs::symlink_metadata(path).map_err(|inspect_error| {
                format!(
                    "Failed to inspect managed file '{}': {inspect_error}",
                    path.display()
                )
            })?;
            if metadata.is_file() && !metadata.file_type().is_symlink() {
                Ok(())
            } else {
                Err(format!(
                    "Refusing unsafe managed file '{}': expected a regular file",
                    path.display()
                ))
            }
        }
        Err(error) => Err(format!(
            "Failed to initialize '{}': {error}",
            path.display()
        )),
    }
}

#[tauri::command]
pub fn open_project_folder(app: AppHandle, path: String) -> Result<(), String> {
    run_guarded("open_project_folder", || {
        let root = Path::new(&path);
        validate_wiki_project_root(root)?;

        let canonical = root
            .canonicalize()
            .map_err(|e| format!("Failed to resolve project path '{}': {}", path, e))?;
        let canonical = canonical.to_string_lossy().to_string();

        match app.opener().open_path(canonical.clone(), None::<&str>) {
            Ok(()) => Ok(()),
            Err(open_err) => app
                .opener()
                .reveal_item_in_dir(canonical)
                .map_err(|reveal_err| {
                    format!(
                        "Failed to open project folder: {}; reveal fallback also failed: {}",
                        open_err, reveal_err
                    )
                }),
        }
    })
}

#[tauri::command]
pub fn open_path_in_project(
    app: AppHandle,
    project_path: String,
    target_path: String,
) -> Result<(), String> {
    run_guarded("open_path_in_project", || {
        let root = Path::new(&project_path);
        validate_wiki_project_root(root)?;

        let root_canonical = root
            .canonicalize()
            .map_err(|e| format!("Failed to resolve project path '{}': {}", project_path, e))?;
        let target = Path::new(&target_path);
        let target = if target.is_absolute() {
            target.to_path_buf()
        } else {
            root_canonical.join(target)
        };
        let target_canonical = target.canonicalize().map_err(|e| {
            format!(
                "Failed to resolve target path '{}': {}",
                target.display(),
                e
            )
        })?;

        if !target_canonical.starts_with(&root_canonical) {
            return Err(format!(
                "Refusing to open a path outside the project: '{}'",
                target_canonical.display()
            ));
        }

        let target = target_canonical.to_string_lossy().to_string();
        match app.opener().open_path(target.clone(), None::<&str>) {
            Ok(()) => Ok(()),
            Err(open_err) => app
                .opener()
                .reveal_item_in_dir(target)
                .map_err(|reveal_err| {
                    format!(
                        "Failed to open project path: {}; reveal fallback also failed: {}",
                        open_err, reveal_err
                    )
                }),
        }
    })
}

fn validate_wiki_project_root(root: &Path) -> Result<(), String> {
    if !root.exists() {
        return Err(format!("Path does not exist: '{}'", root.display()));
    }
    if !root.is_dir() {
        return Err(format!("Path is not a directory: '{}'", root.display()));
    }

    if !root.join("schema.md").exists() {
        return Err(format!(
            "Not a valid wiki project (missing schema.md): '{}'",
            root.display()
        ));
    }
    if !root.join("wiki").is_dir() {
        return Err(format!(
            "Not a valid wiki project (missing wiki/ directory): '{}'",
            root.display()
        ));
    }

    Ok(())
}

fn write_file_inner(path: std::path::PathBuf, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            format!(
                "Failed to create parent dirs for '{}': {}",
                path.display(),
                e
            )
        })?;
    }
    fs::write(&path, contents)
        .map_err(|e| format!("Failed to write file '{}': {}", path.display(), e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn opening_existing_obsidian_vault_is_non_destructive() {
        let root = std::env::temp_dir().join(format!("llm-wiki-obsidian-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join(".obsidian/plugins/community-plugin")).unwrap();
        fs::create_dir_all(root.join("attachments")).unwrap();
        fs::write(
            root.join(".obsidian/app.json"),
            r#"{"attachmentFolderPath":"attachments","unknownSetting":true}"#,
        )
        .unwrap();
        let note = "---\naliases: [Existing]\n---\n\n# Existing\n\nSee [[Other Note]].\n";
        fs::write(root.join("Existing.md"), note).unwrap();
        fs::write(root.join("attachments/image.png"), [0_u8, 1, 2, 255]).unwrap();
        fs::write(
            root.join(".obsidian/plugins/community-plugin/data.json"),
            "plugin state",
        )
        .unwrap();

        let opened = open_project(root.to_string_lossy().into_owned()).unwrap();

        assert_eq!(opened.path, root.to_string_lossy().replace('\\', "/"));
        assert!(root.join("wiki").is_dir());
        assert!(root.join("raw/sources").is_dir());
        assert!(root.join("schema.md").is_file());
        assert_eq!(fs::read_to_string(root.join("Existing.md")).unwrap(), note);
        assert_eq!(
            fs::read_to_string(root.join(".obsidian/app.json")).unwrap(),
            r#"{"attachmentFolderPath":"attachments","unknownSetting":true}"#
        );
        assert_eq!(
            fs::read(root.join("attachments/image.png")).unwrap(),
            [0_u8, 1, 2, 255]
        );
        assert_eq!(
            fs::read_to_string(root.join(".obsidian/plugins/community-plugin/data.json")).unwrap(),
            "plugin state"
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn existing_vault_adoption_rejects_symlinked_managed_directories() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!("llm-wiki-obsidian-{}", Uuid::new_v4()));
        let outside =
            std::env::temp_dir().join(format!("llm-wiki-obsidian-outside-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join(".obsidian")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, root.join("wiki")).unwrap();

        let error = open_project(root.to_string_lossy().into_owned()).unwrap_err();

        assert!(error.contains("managed directory"));
        assert!(!outside.join("entities").exists());
        assert!(!root.join("schema.md").exists());

        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn existing_vault_adoption_rejects_unsafe_managed_files() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!("llm-wiki-obsidian-{}", Uuid::new_v4()));
        let outside =
            std::env::temp_dir().join(format!("llm-wiki-obsidian-outside-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join(".obsidian")).unwrap();
        fs::write(&outside, "outside").unwrap();
        symlink(&outside, root.join("schema.md")).unwrap();

        let error = open_project(root.to_string_lossy().into_owned()).unwrap_err();

        assert!(error.contains("managed file"));
        assert_eq!(fs::read_to_string(&outside).unwrap(), "outside");
        fs::remove_dir_all(&root).unwrap();
        fs::remove_file(&outside).unwrap();

        let root = std::env::temp_dir().join(format!("llm-wiki-obsidian-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join(".obsidian")).unwrap();
        fs::create_dir(root.join("schema.md")).unwrap();

        let error = open_project(root.to_string_lossy().into_owned()).unwrap_err();

        assert!(error.contains("managed file"));
        fs::remove_dir_all(root).unwrap();
    }
}
