//! Google Drive connector (Drive API v3, read-only scope).
//!
//! * First run: breadth-first walk from the configured folder (or "My
//!   Drive" root) with `files.list`, remembering each folder's path. The
//!   `changes.getStartPageToken` value taken *before* the walk becomes the
//!   sync cursor.
//! * Later runs: `changes.list` from the cursor — only touched files come
//!   back, with `removed`/`trashed` flags — and the new start token becomes
//!   the next cursor. Paths are resolved through `files.get` on parents
//!   (memoised per run).
//! * Google-native documents (Docs / Sheets / Slides) are exported as
//!   `.docx` / `.xlsx` / `.pptx` so the existing Office parsers handle them.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::Value;

use super::{
    AuthKind, ConfigField, Connector, ConnectorDescriptor, ConnectorInstance, Fetched, FieldKind,
    Listing, RemoteItem, Secrets,
};
use crate::app_ctx::AppCtx;

pub const KIND: &str = "google-drive";
const PROVIDER: &str = "google";
const API: &str = "https://www.googleapis.com/drive/v3";
const FOLDER_MIME: &str = "application/vnd.google-apps.folder";
const FILE_FIELDS: &str = "id,name,mimeType,size,modifiedTime,md5Checksum,version,parents,trashed";
const EXPORT_LIMIT_BYTES: usize = 10 * 1024 * 1024;

pub fn descriptor() -> ConnectorDescriptor {
    ConnectorDescriptor {
        kind: KIND.into(),
        label: "Google Drive".into(),
        description: "Sync a Drive folder (or all of My Drive). Docs, Sheets and Slides are exported as Office files.".into(),
        auth: AuthKind::OAuth2 {
            provider: PROVIDER.into(),
            scopes: vec!["https://www.googleapis.com/auth/drive.readonly".into()],
        },
        supports_delta: true,
        fields: vec![
            ConfigField {
                key: "clientId".into(),
                label: "OAuth client ID".into(),
                kind: FieldKind::Text,
                required: true,
                placeholder: Some("1234567890-abc.apps.googleusercontent.com".into()),
                help: Some("From Google Cloud Console → APIs & Services → Credentials. Desktop app type for the desktop build; Web application type (with the redirect URI shown below) for the web server.".into()),
                default: None,
            },
            ConfigField {
                key: "clientSecret".into(),
                label: "OAuth client secret".into(),
                kind: FieldKind::Secret,
                required: true,
                placeholder: None,
                help: None,
                default: None,
            },
            ConfigField {
                key: "folderId".into(),
                label: "Folder ID".into(),
                kind: FieldKind::Text,
                required: false,
                placeholder: Some("leave blank for all of My Drive".into()),
                help: Some("The last part of the folder URL: drive.google.com/drive/folders/<ID>".into()),
                default: None,
            },
            ConfigField {
                key: "exportGoogleDocs".into(),
                label: "Export Google Docs / Sheets / Slides".into(),
                kind: FieldKind::Boolean,
                required: false,
                placeholder: None,
                help: Some("Exported as .docx / .xlsx / .pptx (Drive limits exports to 10 MB).".into()),
                default: Some(Value::Bool(true)),
            },
        ],
    }
}

pub struct GoogleDriveConnector {
    ctx: AppCtx,
    instance_id: String,
    folder_id: Option<String>,
    export_docs: bool,
    client: reqwest::Client,
    /// Real id of the sync root ("root" is only an alias in queries; change
    /// feeds report the actual id in `parents`). Resolved at the start of a run.
    resolved_root: Mutex<Option<String>>,
    /// folder id → path components (memo for the current run)
    folder_paths: Mutex<HashMap<String, Option<Vec<String>>>>,
}

impl GoogleDriveConnector {
    pub fn new(ctx: &AppCtx, instance: &ConnectorInstance, _secrets: &Secrets) -> Result<Self, String> {
        let folder_id = instance
            .config
            .get("folderId")
            .and_then(Value::as_str)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .map(|s| extract_folder_id(&s));
        Ok(Self {
            ctx: ctx.clone(),
            instance_id: instance.id.clone(),
            folder_id,
            export_docs: instance
                .config
                .get("exportGoogleDocs")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            client: reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(30))
                .build()
                .map_err(|e| e.to_string())?,
            resolved_root: Mutex::new(None),
            folder_paths: Mutex::new(HashMap::new()),
        })
    }

    fn root_id(&self) -> String {
        self.resolved_root
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
            .or_else(|| self.folder_id.clone())
            .unwrap_or_else(|| "root".to_string())
    }

    async fn resolve_root(&self) -> Result<(), String> {
        let alias = self.folder_id.clone().unwrap_or_else(|| "root".to_string());
        let meta = self
            .get_json(&format!("{API}/files/{alias}?fields=id&supportsAllDrives=true"))
            .await?;
        let id = meta
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "Drive did not return the root folder id".to_string())?;
        *self.resolved_root.lock().unwrap_or_else(|p| p.into_inner()) = Some(id);
        Ok(())
    }

    async fn token(&self) -> Result<String, String> {
        super::oauth::access_token(&self.ctx, &self.instance_id, PROVIDER).await
    }

    async fn get_json(&self, url: &str) -> Result<Value, String> {
        let token = self.token().await?;
        let response = self
            .client
            .get(url)
            .bearer_auth(&token)
            .send()
            .await
            .map_err(|e| format!("Drive request failed: {e}"))?;
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(format!("Drive API {status}: {}", trim_error(&body)));
        }
        serde_json::from_str(&body).map_err(|e| format!("Drive API returned invalid JSON: {e}"))
    }

    async fn get_bytes(&self, url: &str) -> Result<Vec<u8>, String> {
        let token = self.token().await?;
        let response = self
            .client
            .get(url)
            .bearer_auth(&token)
            .send()
            .await
            .map_err(|e| format!("Drive download failed: {e}"))?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(format!("Drive API {status}: {}", trim_error(&body)));
        }
        response
            .bytes()
            .await
            .map(|b| b.to_vec())
            .map_err(|e| format!("Drive download failed: {e}"))
    }

    async fn start_page_token(&self) -> Result<String, String> {
        let value = self
            .get_json(&format!("{API}/changes/startPageToken?supportsAllDrives=true"))
            .await?;
        value
            .get("startPageToken")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "Drive did not return a start page token".into())
    }

    /// Path of a folder relative to the sync root: `Some(vec![])` for the
    /// root itself, `None` when the folder is not under the root.
    async fn folder_path(&self, folder_id: &str) -> Result<Option<Vec<String>>, String> {
        let root = self.root_id();
        if folder_id == root {
            return Ok(Some(Vec::new()));
        }
        if let Some(cached) = self
            .folder_paths
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(folder_id)
        {
            return Ok(cached.clone());
        }
        // Walk up through parents until we hit the root, a memoised
        // ancestor, or the top of the drive (→ outside the sync root).
        let mut names: Vec<String> = Vec::new(); // child-first
        let mut current = folder_id.to_string();
        let mut result: Option<Vec<String>> = None;
        for _ in 0..64 {
            let meta = self
                .get_json(&format!(
                    "{API}/files/{current}?fields=id,name,parents&supportsAllDrives=true"
                ))
                .await?;
            names.push(meta.get("name").and_then(Value::as_str).unwrap_or("").to_string());
            let Some(parent) = meta
                .get("parents")
                .and_then(Value::as_array)
                .and_then(|a| a.first())
                .and_then(Value::as_str)
                .map(str::to_string)
            else {
                break; // top of the drive without meeting the root
            };
            if parent == root {
                result = Some(names.iter().rev().cloned().collect());
                break;
            }
            let cached = self
                .folder_paths
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .get(&parent)
                .cloned();
            if let Some(cached) = cached {
                result = cached.map(|mut base| {
                    base.extend(names.iter().rev().cloned());
                    base
                });
                break;
            }
            current = parent;
        }
        self.folder_paths
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(folder_id.to_string(), result.clone());
        Ok(result)
    }

    async fn full_listing(&self) -> Result<Listing, String> {
        let cursor = self.start_page_token().await?;
        let mut items = Vec::new();
        let mut queue: VecDeque<(String, Vec<String>)> = VecDeque::new();
        queue.push_back((self.root_id(), Vec::new()));
        let mut visited: HashSet<String> = HashSet::new();
        while let Some((folder, path)) = queue.pop_front() {
            if !visited.insert(folder.clone()) {
                continue;
            }
            let mut page_token: Option<String> = None;
            loop {
                let q = format!("'{}' in parents and trashed = false", folder.replace('\'', "\\'"));
                let mut url = format!(
                    "{API}/files?q={}&fields=nextPageToken,files({FILE_FIELDS})&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true",
                    urlenc(&q)
                );
                if let Some(token) = &page_token {
                    url.push_str("&pageToken=");
                    url.push_str(&urlenc(token));
                }
                let page: FilesPage = serde_json::from_value(self.get_json(&url).await?)
                    .map_err(|e| format!("unexpected files.list response: {e}"))?;
                for file in page.files {
                    if file.mime_type == FOLDER_MIME {
                        let mut sub = path.clone();
                        sub.push(file.name.clone());
                        self.folder_paths
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .insert(file.id.clone(), Some(sub.clone()));
                        queue.push_back((file.id, sub));
                        continue;
                    }
                    if let Some(item) = self.to_item(file, &path) {
                        items.push(item);
                    }
                }
                match page.next_page_token {
                    Some(next) => page_token = Some(next),
                    None => break,
                }
            }
        }
        Ok(Listing {
            items,
            is_delta: false,
            next_cursor: Some(cursor),
        })
    }

    async fn delta_listing(&self, cursor: &str) -> Result<Listing, String> {
        let mut items = Vec::new();
        let mut page_token = cursor.to_string();
        let mut new_start: Option<String> = None;
        loop {
            let url = format!(
                "{API}/changes?pageToken={}&fields=nextPageToken,newStartPageToken,changes(changeType,fileId,removed,file({FILE_FIELDS}))&pageSize=1000&includeRemoved=true&supportsAllDrives=true&includeItemsFromAllDrives=true",
                urlenc(&page_token)
            );
            let page: ChangesPage = serde_json::from_value(self.get_json(&url).await?)
                .map_err(|e| format!("unexpected changes.list response: {e}"))?;
            for change in page.changes {
                if change.change_type.as_deref() == Some("drive") {
                    continue;
                }
                let id = change.file_id.clone().unwrap_or_default();
                if id.is_empty() {
                    continue;
                }
                let removed = change.removed
                    || change.file.as_ref().map(|f| f.trashed).unwrap_or(false);
                match change.file {
                    Some(file) if !removed && file.mime_type != FOLDER_MIME => {
                        let parent = file.parents.first().cloned();
                        let path = match parent {
                            Some(p) => self.folder_path(&p).await?,
                            None => None,
                        };
                        match path {
                            Some(path) => {
                                if let Some(item) = self.to_item(file, &path) {
                                    items.push(item);
                                }
                            }
                            // Moved out of the synced folder: treat as removed.
                            None => items.push(deleted_item(&id)),
                        }
                    }
                    Some(file) if file.mime_type == FOLDER_MIME => {
                        // Folder renames/moves change paths of their
                        // children; a later full re-list would catch it. Keep
                        // deltas simple: invalidate the memo.
                        self.folder_paths
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .remove(&id);
                    }
                    _ => items.push(deleted_item(&id)),
                }
            }
            if let Some(token) = page.new_start_page_token {
                new_start = Some(token);
            }
            match page.next_page_token {
                Some(next) => page_token = next,
                None => break,
            }
        }
        Ok(Listing {
            items,
            is_delta: true,
            next_cursor: new_start.or_else(|| Some(cursor.to_string())),
        })
    }

    fn to_item(&self, file: DriveFile, dir_path: &[String]) -> Option<RemoteItem> {
        let native = file.mime_type.starts_with("application/vnd.google-apps.");
        if native {
            if !self.export_docs || export_mapping(&file.mime_type).is_none() {
                return None;
            }
        }
        let mut path = dir_path.to_vec();
        path.push(file.name.clone());
        let version = file
            .md5_checksum
            .clone()
            .unwrap_or_else(|| format!("{}:{}", file.modified_time.clone().unwrap_or_default(), file.version.clone().unwrap_or_default()));
        Some(RemoteItem {
            id: file.id,
            name: file.name,
            path,
            mime: Some(file.mime_type),
            size: file.size.and_then(|s| s.parse().ok()),
            modified: file.modified_time,
            version,
            deleted: false,
            is_dir: false,
        })
    }
}

fn deleted_item(id: &str) -> RemoteItem {
    RemoteItem {
        id: id.to_string(),
        path: Vec::new(),
        name: id.to_string(),
        mime: None,
        size: None,
        modified: None,
        version: String::new(),
        deleted: true,
        is_dir: false,
    }
}

/// Export target for Google-native types: (export mime, file extension).
fn export_mapping(mime: &str) -> Option<(&'static str, &'static str)> {
    match mime {
        "application/vnd.google-apps.document" => Some((
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "docx",
        )),
        "application/vnd.google-apps.spreadsheet" => Some((
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "xlsx",
        )),
        "application/vnd.google-apps.presentation" => Some((
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "pptx",
        )),
        _ => None,
    }
}

/// Accept a bare id or a full Drive folder URL.
fn extract_folder_id(input: &str) -> String {
    if let Some(idx) = input.find("/folders/") {
        let rest = &input[idx + "/folders/".len()..];
        return rest
            .split(|c: char| c == '/' || c == '?' || c == '#')
            .next()
            .unwrap_or(rest)
            .to_string();
    }
    input.to_string()
}

fn urlenc(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn trim_error(body: &str) -> String {
    serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| {
            v.get("error")
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| body.chars().take(300).collect())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DriveFile {
    id: String,
    name: String,
    mime_type: String,
    #[serde(default)]
    size: Option<String>,
    #[serde(default)]
    modified_time: Option<String>,
    #[serde(default)]
    md5_checksum: Option<String>,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    parents: Vec<String>,
    #[serde(default)]
    trashed: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FilesPage {
    #[serde(default)]
    files: Vec<DriveFile>,
    #[serde(default)]
    next_page_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Change {
    #[serde(default)]
    change_type: Option<String>,
    #[serde(default)]
    file_id: Option<String>,
    #[serde(default)]
    removed: bool,
    #[serde(default)]
    file: Option<DriveFile>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangesPage {
    #[serde(default)]
    changes: Vec<Change>,
    #[serde(default)]
    next_page_token: Option<String>,
    #[serde(default)]
    new_start_page_token: Option<String>,
}

#[async_trait]
impl Connector for GoogleDriveConnector {
    fn kind(&self) -> &'static str {
        KIND
    }

    async fn test(&self) -> Result<String, String> {
        let about = self
            .get_json(&format!("{API}/about?fields=user(emailAddress,displayName)"))
            .await?;
        let email = about
            .pointer("/user/emailAddress")
            .and_then(Value::as_str)
            .unwrap_or("?");
        let root = self
            .get_json(&format!(
                "{API}/files/{}?fields=id,name&supportsAllDrives=true",
                self.folder_id.clone().unwrap_or_else(|| "root".to_string())
            ))
            .await?;
        let folder = root.get("name").and_then(Value::as_str).unwrap_or("My Drive");
        Ok(format!("Connected as {email}; syncing \"{folder}\"."))
    }

    async fn list_all(&self, cursor: Option<&str>) -> Result<Listing, String> {
        self.folder_paths
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clear();
        self.resolve_root().await?;
        match cursor {
            Some(token) if !token.is_empty() => match self.delta_listing(token).await {
                Ok(listing) => Ok(listing),
                // Expired page tokens (Drive keeps them ~a week) → resync.
                Err(err) if err.contains("410") || err.contains("pageToken") => {
                    eprintln!("[connectors/google-drive] delta cursor rejected ({err}); full resync");
                    self.full_listing().await
                }
                Err(err) => Err(err),
            },
            _ => self.full_listing().await,
        }
    }

    async fn fetch(&self, item: &RemoteItem) -> Result<Fetched, String> {
        let mime = item.mime.as_deref().unwrap_or("");
        if let Some((export_mime, ext)) = export_mapping(mime) {
            let bytes = self
                .get_bytes(&format!(
                    "{API}/files/{}/export?mimeType={}",
                    item.id,
                    urlenc(export_mime)
                ))
                .await?;
            if bytes.len() > EXPORT_LIMIT_BYTES {
                return Err("export exceeds Drive's 10 MB export limit".into());
            }
            let file_name = if item.name.to_ascii_lowercase().ends_with(&format!(".{ext}")) {
                item.name.clone()
            } else {
                format!("{}.{ext}", item.name)
            };
            return Ok(Fetched { bytes, file_name });
        }
        if mime.starts_with("application/vnd.google-apps.") {
            return Err(format!("unsupported Google-native type {mime}"));
        }
        let bytes = self
            .get_bytes(&format!(
                "{API}/files/{}?alt=media&supportsAllDrives=true",
                item.id
            ))
            .await?;
        Ok(Fetched {
            bytes,
            file_name: item.name.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_id_from_url_or_bare() {
        assert_eq!(
            extract_folder_id("https://drive.google.com/drive/folders/1AbC_def?usp=sharing"),
            "1AbC_def"
        );
        assert_eq!(extract_folder_id("1AbC_def"), "1AbC_def");
    }

    #[test]
    fn export_targets() {
        assert_eq!(export_mapping("application/vnd.google-apps.document").unwrap().1, "docx");
        assert_eq!(export_mapping("application/vnd.google-apps.spreadsheet").unwrap().1, "xlsx");
        assert!(export_mapping("application/vnd.google-apps.form").is_none());
        assert!(export_mapping("application/pdf").is_none());
    }

    #[test]
    fn drive_error_bodies_are_trimmed() {
        let body = r#"{"error":{"code":403,"message":"Insufficient Permission"}}"#;
        assert_eq!(trim_error(body), "Insufficient Permission");
    }
}
