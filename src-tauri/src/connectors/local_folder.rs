//! Local folder connector: mirrors a directory on the machine running the
//! backend. No auth, no delta — a full walk each run, with `mtime+size` as
//! the version token. Doubles as the reference implementation and the test
//! bed for the sync engine.

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use serde_json::Value;
use walkdir::WalkDir;

use super::{
    ConfigField, Connector, ConnectorDescriptor, ConnectorInstance, Fetched, FieldKind, Listing,
    RemoteItem,
};

pub const KIND: &str = "local-folder";

pub fn descriptor() -> ConnectorDescriptor {
    ConnectorDescriptor {
        kind: KIND.into(),
        label: "Local folder".into(),
        description: "Mirror a folder on the server / this computer into the project sources.".into(),
        auth: super::AuthKind::None,
        supports_delta: false,
        fields: vec![
            ConfigField {
                key: "path".into(),
                label: "Folder path".into(),
                kind: FieldKind::Path,
                required: true,
                placeholder: Some("/home/me/Documents/papers".into()),
                help: Some("Absolute path. Hidden entries are skipped.".into()),
                default: None,
            },
            ConfigField {
                key: "followSymlinks".into(),
                label: "Follow symbolic links".into(),
                kind: FieldKind::Boolean,
                required: false,
                placeholder: None,
                help: None,
                default: Some(Value::Bool(false)),
            },
        ],
    }
}

pub struct LocalFolderConnector {
    root: PathBuf,
    follow_symlinks: bool,
}

impl LocalFolderConnector {
    pub fn new(instance: &ConnectorInstance) -> Result<Self, String> {
        let path = instance
            .config
            .get("path")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .ok_or_else(|| "Local folder connector needs a folder path".to_string())?;
        let root = PathBuf::from(path);
        if !root.is_absolute() {
            return Err("Folder path must be absolute".into());
        }
        Ok(Self {
            root,
            follow_symlinks: instance
                .config
                .get("followSymlinks")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        })
    }

    fn relative_components(&self, path: &Path) -> Option<Vec<String>> {
        let rel = path.strip_prefix(&self.root).ok()?;
        let mut parts = Vec::new();
        for component in rel.components() {
            match component {
                std::path::Component::Normal(name) => parts.push(name.to_string_lossy().into_owned()),
                _ => return None,
            }
        }
        if parts.is_empty() {
            None
        } else {
            Some(parts)
        }
    }
}

#[async_trait]
impl Connector for LocalFolderConnector {
    fn kind(&self) -> &'static str {
        KIND
    }

    async fn test(&self) -> Result<String, String> {
        if !self.root.is_dir() {
            return Err(format!("Not a directory: {}", self.root.display()));
        }
        let count = WalkDir::new(&self.root)
            .max_depth(1)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|e| e.file_type().is_file())
            .count();
        Ok(format!("Readable. {count} file(s) at the top level."))
    }

    async fn list_all(&self, _cursor: Option<&str>) -> Result<Listing, String> {
        let root = self.root.clone();
        let follow = self.follow_symlinks;
        let items = crate::rt::spawn_blocking(move || -> Result<Vec<RemoteItem>, String> {
            if !root.is_dir() {
                return Err(format!("Not a directory: {}", root.display()));
            }
            let mut items = Vec::new();
            let walker = WalkDir::new(&root).follow_links(follow).into_iter();
            for entry in walker.filter_entry(|e| {
                // Skip hidden files/dirs anywhere below the root.
                e.depth() == 0
                    || !e
                        .file_name()
                        .to_str()
                        .map(|n| n.starts_with('.'))
                        .unwrap_or(false)
            }) {
                let entry = match entry {
                    Ok(e) => e,
                    Err(err) => {
                        eprintln!("[connectors/local-folder] skipping entry: {err}");
                        continue;
                    }
                };
                if !entry.file_type().is_file() {
                    continue;
                }
                let Ok(meta) = entry.metadata() else { continue };
                let mtime = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                let rel = entry.path().strip_prefix(&root).ok().map(|p| {
                    p.components()
                        .filter_map(|c| match c {
                            std::path::Component::Normal(n) => Some(n.to_string_lossy().into_owned()),
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                });
                let Some(path) = rel.filter(|p| !p.is_empty()) else { continue };
                let name = path.last().cloned().unwrap_or_default();
                items.push(RemoteItem {
                    id: path.join("/"),
                    name,
                    path,
                    mime: None,
                    size: Some(meta.len()),
                    modified: chrono::DateTime::<chrono::Utc>::from_timestamp_millis(mtime)
                        .map(|t| t.to_rfc3339()),
                    version: format!("{mtime}-{}", meta.len()),
                    deleted: false,
                    is_dir: false,
                });
            }
            Ok(items)
        })
        .await
        .map_err(|e| format!("listing task failed: {e}"))??;
        Ok(Listing {
            items,
            is_delta: false,
            next_cursor: None,
        })
    }

    async fn fetch(&self, item: &RemoteItem) -> Result<Fetched, String> {
        let mut full = self.root.clone();
        for part in &item.path {
            full.push(part);
        }
        if self.relative_components(&full).is_none() {
            return Err("path escapes the connector root".into());
        }
        let bytes = tokio::fs::read(&full)
            .await
            .map_err(|e| format!("cannot read {}: {e}", full.display()))?;
        Ok(Fetched {
            bytes,
            file_name: item.name.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Map;

    #[test]
    fn lists_files_recursively_and_skips_hidden() {
        let root = std::env::temp_dir().join(format!("llm-wiki-lf-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("sub/.hidden")).unwrap();
        std::fs::write(root.join("a.md"), "a").unwrap();
        std::fs::write(root.join("sub/b.txt"), "bb").unwrap();
        std::fs::write(root.join("sub/.hidden/c.md"), "c").unwrap();
        std::fs::write(root.join(".secret.md"), "s").unwrap();
        let mut config = Map::new();
        config.insert("path".into(), Value::String(root.to_string_lossy().into_owned()));
        let instance = ConnectorInstance {
            id: "x".into(),
            kind: KIND.into(),
            name: "t".into(),
            enabled: true,
            interval_minutes: 0,
            config,
            max_file_size_mb: 0,
            created_at: 0,
            last_sync: None,
        };
        let connector = LocalFolderConnector::new(&instance).unwrap();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let listing = rt.block_on(connector.list_all(None)).unwrap();
        let mut ids: Vec<String> = listing.items.iter().map(|i| i.id.clone()).collect();
        ids.sort();
        assert_eq!(ids, vec!["a.md", "sub/b.txt"]);
        let fetched = rt.block_on(connector.fetch(&listing.items[0])).unwrap();
        assert!(!fetched.bytes.is_empty());
        let _ = std::fs::remove_dir_all(root);
    }
}
