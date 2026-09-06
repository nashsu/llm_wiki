//! Source connectors: pull documents from external systems into a project's
//! `raw/sources/` folder, where the existing ingest pipeline picks them up.
//!
//! Three layers, deliberately kept apart:
//!
//! * [`Connector`] — knows how a remote system looks (`list_all`) and how to
//!   download one item (`fetch`). It never touches the wiki, the ingest
//!   queue, or the UI. Implementations live in sibling modules
//!   (`local_folder`, `google_drive`, …).
//! * The registry ([`descriptors`], [`build`]) — the "factory". Each kind
//!   publishes a [`ConnectorDescriptor`] with its config fields and auth
//!   requirements so the settings UI can render a generic form.
//! * [`sync::run_sync`] — the shared engine. Diffs a listing against the
//!   persisted per-instance state, writes/removes files under
//!   `raw/sources/@<instance>/…`, then asks the source-folder watcher to
//!   rescan so the frontend ingests changes exactly as it would for files
//!   edited by hand.
//!
//! Adding a connector = implement the trait + add a descriptor + one match
//! arm in [`build`]. Nothing else needs to know about it.

pub mod commands;
pub mod google_drive;
pub mod local_folder;
pub mod oauth;
pub mod scheduler;
pub mod store;
pub mod sync;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

// ── remote model ────────────────────────────────────────────────────────────

/// One file (or folder) as seen on the remote system.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteItem {
    /// Stable remote identifier (Drive file id, relative path for folders…).
    pub id: String,
    /// Path components relative to the connector root; the last one is the
    /// file name. Used to mirror the remote layout under `raw/sources/`.
    pub path: Vec<String>,
    pub name: String,
    pub mime: Option<String>,
    pub size: Option<u64>,
    /// RFC 3339 when the remote reports it.
    pub modified: Option<String>,
    /// Opaque change token (checksum, etag, mtime+size). Equal version ⇒ the
    /// content is unchanged and the engine skips the download.
    pub version: String,
    /// Delta listings report removals with `deleted = true`.
    #[serde(default)]
    pub deleted: bool,
    #[serde(default)]
    pub is_dir: bool,
}

/// Result of [`Connector::list_all`].
#[derive(Debug, Default)]
pub struct Listing {
    pub items: Vec<RemoteItem>,
    /// `true` when `items` only contains what changed since the cursor the
    /// engine passed in. `false` means a complete snapshot, and the engine
    /// treats anything missing from it as deleted.
    pub is_delta: bool,
    /// Cursor to pass to the next `list_all` call (delta APIs). `None` keeps
    /// full snapshots.
    pub next_cursor: Option<String>,
}

/// Downloaded content for one item.
#[derive(Debug)]
pub struct Fetched {
    pub bytes: Vec<u8>,
    /// File name to store under; may differ from the remote name (Google
    /// Docs export as `.docx`, for example).
    pub file_name: String,
}

/// Why an item was not synced. Surfaced in the sync report.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SkipReason {
    UnsupportedType,
    TooLarge,
    Excluded,
    FetchFailed,
    WriteFailed,
}

#[async_trait]
pub trait Connector: Send + Sync {
    fn kind(&self) -> &'static str;

    /// Cheap connectivity / credentials check.
    async fn test(&self) -> Result<String, String>;

    /// List the remote tree. `cursor` is whatever the previous listing
    /// returned in `next_cursor` (or `None` on the first run / after a
    /// reset). Connectors that cannot do deltas ignore it and return a full
    /// snapshot.
    async fn list_all(&self, cursor: Option<&str>) -> Result<Listing, String>;

    /// Download one item. Returning `Err` records a `FetchFailed` skip and
    /// the engine moves on.
    async fn fetch(&self, item: &RemoteItem) -> Result<Fetched, String>;
}

// ── descriptors (registry) ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FieldKind {
    Text,
    Number,
    Boolean,
    /// Stored in the secrets file, never returned to the UI once saved.
    Secret,
    /// A path on the machine running the backend; the UI offers a folder picker.
    Path,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigField {
    pub key: String,
    pub label: String,
    pub kind: FieldKind,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub placeholder: Option<String>,
    #[serde(default)]
    pub help: Option<String>,
    #[serde(default)]
    pub default: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum AuthKind {
    None,
    /// Bring-your-own OAuth client: the user registers an app with the
    /// provider and pastes client id / secret; tokens are obtained with PKCE
    /// through a loopback / same-origin redirect.
    OAuth2 {
        provider: String,
        scopes: Vec<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorDescriptor {
    pub kind: String,
    pub label: String,
    pub description: String,
    pub auth: AuthKind,
    pub fields: Vec<ConfigField>,
    pub supports_delta: bool,
}

/// Everything the UI needs to offer and configure connectors.
pub fn descriptors() -> Vec<ConnectorDescriptor> {
    vec![local_folder::descriptor(), google_drive::descriptor()]
}

/// The factory: instantiate a connector for a saved instance.
pub fn build(
    ctx: &crate::app_ctx::AppCtx,
    instance: &ConnectorInstance,
    secrets: &Secrets,
) -> Result<Box<dyn Connector>, String> {
    match instance.kind.as_str() {
        local_folder::KIND => Ok(Box::new(local_folder::LocalFolderConnector::new(instance)?)),
        google_drive::KIND => Ok(Box::new(google_drive::GoogleDriveConnector::new(
            ctx, instance, secrets,
        )?)),
        other => Err(format!("Unknown connector kind: {other}")),
    }
}

// ── persisted instance ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncSummary {
    pub started_at: i64,
    pub finished_at: i64,
    pub added: usize,
    pub updated: usize,
    pub deleted: usize,
    pub unchanged: usize,
    pub skipped: usize,
    #[serde(default)]
    pub errors: Vec<String>,
    #[serde(default)]
    pub ok: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorInstance {
    pub id: String,
    pub kind: String,
    pub name: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 0 = manual only.
    #[serde(default)]
    pub interval_minutes: u32,
    /// Non-secret configuration, keyed by [`ConfigField::key`].
    #[serde(default)]
    pub config: Map<String, Value>,
    #[serde(default)]
    pub max_file_size_mb: u64,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub last_sync: Option<SyncSummary>,
}

fn default_true() -> bool {
    true
}

/// Secret values for one instance (client secret, tokens…). Lives in the
/// app data dir, never inside the project folder.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Secrets(pub Map<String, Value>);

impl Secrets {
    pub fn get_str(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
    }
    pub fn set(&mut self, key: &str, value: impl Into<Value>) {
        self.0.insert(key.to_string(), value.into());
    }
    pub fn remove(&mut self, key: &str) {
        self.0.remove(key);
    }
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Folder-name-safe version of an instance name: `@my-drive`.
pub fn instance_folder_name(instance: &ConnectorInstance) -> String {
    let mut slug: String = instance
        .name
        .trim()
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string();
    if slug.is_empty() {
        slug = instance.id.chars().take(8).collect();
    }
    format!("@{slug}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_name_is_sanitized_and_prefixed() {
        let mut inst = ConnectorInstance {
            id: "abcdef1234".into(),
            kind: "local-folder".into(),
            name: "My Drive / work docs".into(),
            enabled: true,
            interval_minutes: 0,
            config: Map::new(),
            max_file_size_mb: 0,
            created_at: 0,
            last_sync: None,
        };
        assert_eq!(instance_folder_name(&inst), "@My-Drive---work-docs");
        inst.name = "   ".into();
        assert_eq!(instance_folder_name(&inst), "@abcdef12");
    }

    #[test]
    fn registry_lists_known_kinds() {
        let kinds: Vec<String> = descriptors().into_iter().map(|d| d.kind).collect();
        assert!(kinds.contains(&"local-folder".to_string()));
        assert!(kinds.contains(&"google-drive".to_string()));
    }
}
