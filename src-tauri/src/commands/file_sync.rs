use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
use std::panic::AssertUnwindSafe;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use md5::{Digest, Md5};
use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use walkdir::WalkDir;

use crate::panic_guard::run_guarded;

const SNAPSHOT_FILE: &str = ".llm-wiki/file-snapshot.json";
const QUEUE_FILE: &str = ".llm-wiki/file-change-queue.json";
const EVENT_QUEUE_UPDATED: &str = "file-sync://queue-updated";
const EVENT_CHANGED: &str = "file-sync://changed";
const MAX_HASH_BYTES: u64 = 32 * 1024 * 1024;
const MAX_RETRY_COUNT: u32 = 3;
const APP_WRITE_IGNORE_MS: i64 = 4_000;
const QUEUE_EMIT_EVERY: usize = 25;
const LINUX_RESCAN_INTERVAL_MS: i64 = 10_000;
const DEFAULT_SOURCE_WATCH_CONFIG_JSON: &str =
    include_str!("../../../src/lib/source-watch-defaults.json");

static QUEUE_LOCKS: OnceLock<Mutex<BTreeMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
static APP_WRITE_IGNORES: OnceLock<Mutex<BTreeMap<String, i64>>> = OnceLock::new();
static WATCHER_GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Default)]
pub struct FileSyncState {
    inner: Mutex<FileSyncInner>,
}

#[derive(Default)]
struct FileSyncInner {
    watcher: Option<RecommendedWatcher>,
    project_id: Option<String>,
    project_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMeta {
    hash: Option<String>,
    size: u64,
    mtime_ms: i64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileSnapshot {
    version: u32,
    updated_at: i64,
    files: BTreeMap<String, FileMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FileChangeKind {
    Created,
    Modified,
    Deleted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FileChangeStatus {
    Pending,
    Processing,
    Done,
    Failed,
    Superseded,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeTask {
    id: String,
    project_id: String,
    path: String,
    kind: FileChangeKind,
    status: FileChangeStatus,
    hash_before: Option<String>,
    hash_after: Option<String>,
    size: Option<u64>,
    mtime_ms: Option<i64>,
    created_at: i64,
    updated_at: i64,
    retry_count: u32,
    error: Option<String>,
    needs_rerun: bool,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeQueue {
    version: u32,
    tasks: Vec<FileChangeTask>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeRescanResult {
    queue: FileChangeQueue,
    changed_tasks: Vec<FileChangeTask>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceWatchConfig {
    #[serde(default = "default_source_watch_enabled")]
    enabled: bool,
    #[serde(default = "default_source_watch_auto_ingest")]
    auto_ingest: bool,
    #[serde(default = "default_source_watch_include_extensions")]
    include_extensions: Vec<String>,
    #[serde(default = "default_source_watch_exclude_extensions")]
    exclude_extensions: Vec<String>,
    #[serde(default = "default_source_watch_exclude_dirs")]
    exclude_dirs: Vec<String>,
    #[serde(default = "default_source_watch_exclude_globs")]
    exclude_globs: Vec<String>,
    #[serde(default = "default_source_watch_max_file_size_mb")]
    max_file_size_mb: u64,
}

impl Default for SourceWatchConfig {
    fn default() -> Self {
        serde_json::from_str(DEFAULT_SOURCE_WATCH_CONFIG_JSON)
            .expect("source-watch-defaults.json must match SourceWatchConfig")
    }
}

fn default_source_watch_config() -> SourceWatchConfig {
    SourceWatchConfig::default()
}

fn default_source_watch_enabled() -> bool {
    default_source_watch_config().enabled
}

fn default_source_watch_auto_ingest() -> bool {
    default_source_watch_config().auto_ingest
}

fn default_source_watch_include_extensions() -> Vec<String> {
    default_source_watch_config().include_extensions
}

fn default_source_watch_exclude_extensions() -> Vec<String> {
    default_source_watch_config().exclude_extensions
}

fn default_source_watch_exclude_dirs() -> Vec<String> {
    default_source_watch_config().exclude_dirs
}

fn default_source_watch_exclude_globs() -> Vec<String> {
    default_source_watch_config().exclude_globs
}

fn default_source_watch_max_file_size_mb() -> u64 {
    default_source_watch_config().max_file_size_mb
}

fn normalize_source_watch_config(config: Option<SourceWatchConfig>) -> SourceWatchConfig {
    let mut config = config.unwrap_or_default();
    config.include_extensions = normalize_ext_list(config.include_extensions);
    config.exclude_extensions = normalize_ext_list(config.exclude_extensions);
    config.exclude_dirs = normalize_string_list(config.exclude_dirs);
    config.exclude_globs = normalize_string_list(config.exclude_globs);
    config.max_file_size_mb = config.max_file_size_mb.clamp(1, 4096);
    config
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileSyncPayload {
    project_id: String,
    tasks: Vec<FileChangeTask>,
}

#[tauri::command]
pub fn start_project_file_watcher(
    app: AppHandle,
    state: State<FileSyncState>,
    project_id: String,
    project_path: String,
    source_watch_config: Option<SourceWatchConfig>,
) -> Result<FileChangeQueue, String> {
    run_guarded("start_project_file_watcher", || {
        let root = PathBuf::from(project_path);
        let source_watch_config = normalize_source_watch_config(source_watch_config);
        let watcher_generation = WATCHER_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
        ensure_sync_dir(&root)?;
        with_queue_lock(&root, || reset_processing_tasks(&root, &project_id))?;
        enqueue_rescan_changes(&root, &project_id, &source_watch_config)?;
        process_queue(&app, &root, &project_id)?;

        let (tx, rx) = mpsc::sync_channel::<PathBuf>(8_192);
        let app_for_thread = app.clone();
        let root_for_thread = root.clone();
        let project_for_thread = project_id.clone();
        let config_for_thread = source_watch_config.clone();
        std::thread::spawn(move || {
            let mut pending = BTreeSet::<PathBuf>::new();
            let mut last_periodic_rescan = now_ms();
            loop {
                match rx.recv_timeout(Duration::from_millis(700)) {
                    Ok(path) => {
                        pending.insert(path);
                        while let Ok(path) = rx.try_recv() {
                            pending.insert(path);
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if pending.is_empty() {
                            maybe_periodic_rescan(
                                &app_for_thread,
                                &root_for_thread,
                                &project_for_thread,
                                &config_for_thread,
                                watcher_generation,
                                &mut last_periodic_rescan,
                            );
                            continue;
                        }
                        let paths = pending.iter().cloned().collect::<Vec<_>>();
                        pending.clear();
                        let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
                            handle_changed_paths(
                                &app_for_thread,
                                &root_for_thread,
                                &project_for_thread,
                                &config_for_thread,
                                watcher_generation,
                                paths,
                            )
                        }));
                        match result {
                            Ok(Ok(())) => {}
                            Ok(Err(err)) => eprintln!("[file-sync] change handling failed: {err}"),
                            Err(_) => eprintln!("[file-sync] watcher worker recovered from panic"),
                        }
                        maybe_periodic_rescan(
                            &app_for_thread,
                            &root_for_thread,
                            &project_for_thread,
                            &config_for_thread,
                            watcher_generation,
                            &mut last_periodic_rescan,
                        );
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
        });

        let tx_for_watcher = tx.clone();
        let root_for_overflow = root.clone();
        let root_for_error = root.clone();
        let mut watcher = RecommendedWatcher::new(
            move |res: notify::Result<Event>| {
                match res {
                    Ok(event) => {
                        for path in event.paths {
                            if tx_for_watcher.try_send(path).is_err() {
                                let _ = tx_for_watcher.try_send(root_for_overflow.clone());
                                break;
                            }
                        }
                    }
                    Err(err) => {
                        eprintln!("[file-sync] watcher error; scheduling rescan: {err}");
                        let _ = tx_for_watcher.try_send(root_for_error.clone());
                    }
                }
            },
            Config::default(),
        )
        .map_err(|e| format!("Failed to create file watcher: {e}"))?;
        watcher
            .watch(&root, RecursiveMode::Recursive)
            .map_err(|e| format!("Failed to watch '{}': {e}", root.display()))?;
        for rel in ["raw/sources", "wiki"] {
            let path = root.join(rel);
            if path.exists() {
                if let Err(err) = watcher.watch(&path, RecursiveMode::Recursive) {
                    eprintln!(
                        "[file-sync] failed to add supplemental watch '{}': {err}",
                        path.display()
                    );
                }
            }
        }

        {
            let mut inner = state.inner.lock().map_err(|_| "file sync state poisoned")?;
            inner.watcher = Some(watcher);
            inner.project_id = Some(project_id.clone());
            inner.project_path = Some(root.clone());
        }

        let queue = with_queue_lock(&root, || read_queue(&root))?;
        emit_queue(&app, &project_id, &queue);
        Ok(queue)
    })
}

#[tauri::command]
pub fn stop_project_file_watcher(state: State<FileSyncState>) -> Result<(), String> {
    run_guarded("stop_project_file_watcher", || {
        WATCHER_GENERATION.fetch_add(1, Ordering::SeqCst);
        let mut inner = state.inner.lock().map_err(|_| "file sync state poisoned")?;
        inner.watcher = None;
        inner.project_id = None;
        inner.project_path = None;
        Ok(())
    })
}

#[tauri::command]
pub fn rescan_project_files(
    app: AppHandle,
    project_id: String,
    project_path: String,
    source_watch_config: Option<SourceWatchConfig>,
) -> Result<FileChangeRescanResult, String> {
    run_guarded("rescan_project_files", || {
        let root = PathBuf::from(project_path);
        let source_watch_config = normalize_source_watch_config(source_watch_config);
        ensure_sync_dir(&root)?;
        enqueue_rescan_changes(&root, &project_id, &source_watch_config)?;
        let changed_tasks = process_queue(&app, &root, &project_id)?;
        let queue = with_queue_lock(&root, || read_queue(&root))?;
        emit_queue(&app, &project_id, &queue);
        Ok(FileChangeRescanResult {
            queue,
            changed_tasks,
        })
    })
}

#[tauri::command]
pub fn get_file_change_queue(project_path: String) -> Result<FileChangeQueue, String> {
    run_guarded("get_file_change_queue", || {
        let root = PathBuf::from(project_path);
        with_queue_lock(&root, || read_queue(&root))
    })
}

#[tauri::command]
pub fn retry_file_change_task(
    app: AppHandle,
    project_id: String,
    project_path: String,
    task_id: String,
) -> Result<FileChangeQueue, String> {
    run_guarded("retry_file_change_task", || {
        let root = PathBuf::from(project_path);
        with_queue_lock(&root, || {
            let mut queue = read_queue(&root)?;
            let now = now_ms();
            for task in &mut queue.tasks {
                if task.id == task_id && task.project_id == project_id {
                    task.status = FileChangeStatus::Pending;
                    task.error = None;
                    task.retry_count = 0;
                    task.needs_rerun = false;
                    task.updated_at = now;
                }
            }
            write_queue(&root, &queue)
        })?;
        process_queue(&app, &root, &project_id)?;
        let queue = with_queue_lock(&root, || read_queue(&root))?;
        emit_queue(&app, &project_id, &queue);
        Ok(queue)
    })
}

#[tauri::command]
pub fn ignore_file_change_task(
    app: AppHandle,
    project_id: String,
    project_path: String,
    task_id: String,
) -> Result<FileChangeQueue, String> {
    run_guarded("ignore_file_change_task", || {
        let root = PathBuf::from(project_path);
        let queue = with_queue_lock(&root, || {
            let mut queue = read_queue(&root)?;
            queue
                .tasks
                .retain(|task| !(task.id == task_id && task.project_id == project_id));
            write_queue(&root, &queue)?;
            read_queue(&root)
        })?;
        emit_queue(&app, &project_id, &queue);
        Ok(queue)
    })
}

pub fn mark_app_write_path(path: &Path) {
    let key = path_key(path);
    let now = now_ms();
    let mut ignores = APP_WRITE_IGNORES
        .get_or_init(|| Mutex::new(BTreeMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    ignores.retain(|_, expires_at| *expires_at > now);
    ignores.insert(key, now + APP_WRITE_IGNORE_MS);
}

fn handle_changed_paths(
    app: &AppHandle,
    root: &Path,
    project_id: &str,
    source_watch_config: &SourceWatchConfig,
    watcher_generation: u64,
    paths: Vec<PathBuf>,
) -> Result<(), String> {
    if !is_active_watcher_generation(watcher_generation) {
        return Ok(());
    }
    let rules = SourceWatchRules::new(source_watch_config);
    let mut rels = BTreeSet::<String>::new();
    let mut app_written_rels = BTreeSet::<String>::new();
    let snapshot = with_queue_lock(root, || read_snapshot(root))?;
    for path in paths {
        if is_app_write_ignored(&path) {
            collect_known_paths(root, &path, &snapshot, &mut app_written_rels, &rules);
            continue;
        }
        if path.is_dir() {
            for entry in WalkDir::new(&path).into_iter().filter_map(Result::ok) {
                if entry.file_type().is_file() && !is_app_write_ignored(entry.path()) {
                    if let Some(rel) = relative_watch_path(root, entry.path(), &rules, entry.metadata().ok().map(|m| m.len())) {
                        rels.insert(rel);
                    }
                }
            }
        } else if let Some(rel) = relative_watch_path(root, &path, &rules, None) {
            rels.insert(rel);
        } else if !path.exists() {
            collect_known_paths(root, &path, &snapshot, &mut rels, &rules);
        }
    }
    if !app_written_rels.is_empty() {
        sync_snapshot_paths(root, app_written_rels)?;
    }
    if rels.is_empty() {
        return Ok(());
    }
    if !is_active_watcher_generation(watcher_generation) {
        return Ok(());
    }
    enqueue_paths(root, project_id, rels)?;
    if !is_active_watcher_generation(watcher_generation) {
        return Ok(());
    }
    process_queue(app, root, project_id)?;
    let queue = with_queue_lock(root, || read_queue(root))?;
    if !is_active_watcher_generation(watcher_generation) {
        return Ok(());
    }
    emit_queue(app, project_id, &queue);
    Ok(())
}

fn maybe_periodic_rescan(
    app: &AppHandle,
    root: &Path,
    project_id: &str,
    source_watch_config: &SourceWatchConfig,
    watcher_generation: u64,
    last_periodic_rescan: &mut i64,
) {
    if !cfg!(target_os = "linux") || now_ms() - *last_periodic_rescan < LINUX_RESCAN_INTERVAL_MS {
        return;
    }
    *last_periodic_rescan = now_ms();
    let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
        rescan_watch_roots(app, root, project_id, source_watch_config, watcher_generation)
    }));
    match result {
        Ok(Ok(())) => {}
        Ok(Err(err)) => eprintln!("[file-sync] periodic rescan failed: {err}"),
        Err(_) => eprintln!("[file-sync] periodic rescan recovered from panic"),
    }
}

fn rescan_watch_roots(
    app: &AppHandle,
    root: &Path,
    project_id: &str,
    source_watch_config: &SourceWatchConfig,
    watcher_generation: u64,
) -> Result<(), String> {
    if !is_active_watcher_generation(watcher_generation) {
        return Ok(());
    }
    enqueue_rescan_changes_for_prefixes(
        root,
        project_id,
        &["raw/sources", "wiki", "purpose.md", "schema.md"],
        source_watch_config,
    )?;
    if !is_active_watcher_generation(watcher_generation) {
        return Ok(());
    }
    process_queue(app, root, project_id)?;
    let queue = with_queue_lock(root, || read_queue(root))?;
    if !is_active_watcher_generation(watcher_generation) {
        return Ok(());
    }
    emit_queue(app, project_id, &queue);
    Ok(())
}

fn is_active_watcher_generation(generation: u64) -> bool {
    WATCHER_GENERATION.load(Ordering::SeqCst) == generation
}

fn collect_known_paths(
    root: &Path,
    path: &Path,
    snapshot: &FileSnapshot,
    rels: &mut BTreeSet<String>,
    rules: &SourceWatchRules,
) {
    if path.is_dir() {
        for entry in WalkDir::new(path).into_iter().filter_map(Result::ok) {
            if entry.file_type().is_file() {
                if let Some(rel) = relative_watch_path(root, entry.path(), rules, entry.metadata().ok().map(|m| m.len())) {
                    rels.insert(rel);
                }
            }
        }
        return;
    }

    let Ok(rel_path) = path.strip_prefix(root) else {
        return;
    };
    let Some(rel) = normalize_rel_path(rel_path) else {
        return;
    };
    if !path.exists() {
        for known in snapshot.files.keys() {
            if known == &rel || known.starts_with(&format!("{rel}/")) {
                rels.insert(known.clone());
            }
        }
        return;
    }

    if should_watch_rel(&rel, rules) {
        rels.insert(rel);
    }
}

fn sync_snapshot_paths(root: &Path, rels: BTreeSet<String>) -> Result<(), String> {
    let metas = rels
        .into_iter()
        .map(|rel| read_meta(root, &rel).map(|meta| (rel, meta)))
        .collect::<Result<Vec<_>, _>>()?;

    with_queue_lock(root, || {
        let mut snapshot = read_snapshot(root)?;
        for (rel, meta) in metas {
            match meta {
                Some(meta) => {
                    snapshot.files.insert(rel, meta);
                }
                None => {
                    snapshot.files.remove(&rel);
                }
            }
        }
        snapshot.version = 1;
        snapshot.updated_at = now_ms();
        write_snapshot(root, &snapshot)
    })
}

fn enqueue_rescan_changes(
    root: &Path,
    project_id: &str,
    source_watch_config: &SourceWatchConfig,
) -> Result<(), String> {
    let rules = SourceWatchRules::new(source_watch_config);
    let mut rels = BTreeSet::<String>::new();
    for entry in WalkDir::new(root).into_iter().filter_map(Result::ok) {
        if entry.file_type().is_file() {
            if let Some(rel) = relative_watch_path(root, entry.path(), &rules, entry.metadata().ok().map(|m| m.len())) {
                rels.insert(rel);
            }
        }
    }

    let snapshot = with_queue_lock(root, || read_snapshot(root))?;
    for rel in snapshot.files.keys() {
        if !root.join(rel).exists() {
            rels.insert(rel.clone());
        }
    }
    enqueue_paths(root, project_id, rels)
}

fn enqueue_rescan_changes_for_prefixes(
    root: &Path,
    project_id: &str,
    prefixes: &[&str],
    source_watch_config: &SourceWatchConfig,
) -> Result<(), String> {
    let rules = SourceWatchRules::new(source_watch_config);
    let mut rels = BTreeSet::<String>::new();
    let snapshot = with_queue_lock(root, || read_snapshot(root))?;
    for prefix in prefixes {
        let path = root.join(prefix);
        if path.is_file() {
            if let Some(rel) = relative_watch_path(root, &path, &rules, fs::metadata(&path).ok().map(|m| m.len())) {
                let old = snapshot.files.get(&rel);
                let fast = read_meta_fast(root, &rel)?;
                if old.map(|m| (m.size, m.mtime_ms)) != fast.as_ref().map(|m| (m.size, m.mtime_ms)) {
                    rels.insert(rel);
                }
            }
        } else if path.exists() {
            for entry in WalkDir::new(&path).into_iter().filter_map(Result::ok) {
                if entry.file_type().is_file() {
                    if let Some(rel) = relative_watch_path(root, entry.path(), &rules, entry.metadata().ok().map(|m| m.len())) {
                        let old = snapshot.files.get(&rel);
                        let fast = read_meta_fast(root, &rel)?;
                        if old.map(|m| (m.size, m.mtime_ms)) != fast.as_ref().map(|m| (m.size, m.mtime_ms)) {
                            rels.insert(rel);
                        }
                    }
                }
            }
        }
    }

    for rel in snapshot.files.keys() {
        if prefixes
            .iter()
            .any(|prefix| rel == *prefix || rel.starts_with(&format!("{prefix}/")))
            && !root.join(rel).exists()
        {
            rels.insert(rel.clone());
        }
    }

    enqueue_paths(root, project_id, rels)
}

fn enqueue_paths(root: &Path, project_id: &str, rels: BTreeSet<String>) -> Result<(), String> {
    let snapshot = with_queue_lock(root, || read_snapshot(root))?;
    let now = now_ms();
    let mut changes = Vec::new();

    for rel in rels {
        let old = snapshot.files.get(&rel).cloned();
        // Intentional TOCTOU trade-off: `read_meta` can be expensive
        // because it may hash file contents, so it runs outside the queue
        // lock. If another worker updates the snapshot before this task is
        // enqueued, the task may be redundant; processing it is harmless and
        // self-corrects by writing the current on-disk meta back to snapshot.
        let new = read_meta(root, &rel)?;
        if old.as_ref().map(|m| (&m.hash, m.size)) == new.as_ref().map(|m| (&m.hash, m.size)) {
            continue;
        }

        let kind = match (&old, &new) {
            (None, Some(_)) => FileChangeKind::Created,
            (Some(_), None) => FileChangeKind::Deleted,
            (Some(_), Some(_)) => FileChangeKind::Modified,
            (None, None) => continue,
        };
        changes.push((rel, kind, old, new));
    }

    if changes.is_empty() {
        return Ok(());
    }

    with_queue_lock(root, || {
        let mut queue = read_queue(root)?;
        for (rel, kind, old, new) in changes {
            upsert_task(&mut queue, project_id, &rel, kind, old, new, now);
        }
        write_queue(root, &queue)
    })
}

fn upsert_task(
    queue: &mut FileChangeQueue,
    project_id: &str,
    rel: &str,
    kind: FileChangeKind,
    old: Option<FileMeta>,
    new: Option<FileMeta>,
    now: i64,
) {
    if let Some(task) = queue.tasks.iter_mut().find(|t| {
        t.project_id == project_id
            && normalize_key(&t.path) == normalize_key(rel)
            && matches!(
                t.status,
                FileChangeStatus::Pending | FileChangeStatus::Processing | FileChangeStatus::Failed
            )
    }) {
        task.kind = merge_kind(&task.kind, &kind);
        task.hash_after = new.as_ref().and_then(|m| m.hash.clone());
        task.size = new.as_ref().map(|m| m.size);
        task.mtime_ms = new.as_ref().map(|m| m.mtime_ms);
        task.updated_at = now;
        if task.status == FileChangeStatus::Failed {
            if task.retry_count < MAX_RETRY_COUNT {
                task.status = FileChangeStatus::Pending;
                task.error = None;
            } else {
                task.error = Some(format!("Retry limit reached ({MAX_RETRY_COUNT})"));
            }
        } else if task.status == FileChangeStatus::Processing {
            task.needs_rerun = true;
            task.error = None;
        } else {
            task.error = None;
        }
        return;
    }

    queue.tasks.push(FileChangeTask {
        id: format!("change_{}_{}", now, stable_path_hash(rel)),
        project_id: project_id.to_string(),
        path: rel.to_string(),
        kind,
        status: FileChangeStatus::Pending,
        hash_before: old.and_then(|m| m.hash),
        hash_after: new.as_ref().and_then(|m| m.hash.clone()),
        size: new.as_ref().map(|m| m.size),
        mtime_ms: new.as_ref().map(|m| m.mtime_ms),
        created_at: now,
        updated_at: now,
        retry_count: 0,
        error: None,
        needs_rerun: false,
    });
}

fn process_queue(app: &AppHandle, root: &Path, project_id: &str) -> Result<Vec<FileChangeTask>, String> {
    process_queue_inner(
        root,
        project_id,
        |queue| emit_queue(app, project_id, queue),
        |tasks| emit_changed_batch(app, project_id, tasks),
    )
}

fn process_queue_inner(
    root: &Path,
    project_id: &str,
    mut on_queue: impl FnMut(&FileChangeQueue),
    mut on_changed: impl FnMut(Vec<FileChangeTask>),
) -> Result<Vec<FileChangeTask>, String> {
    let mut changed_tasks = Vec::<FileChangeTask>::new();
    let mut all_changed_tasks = Vec::<FileChangeTask>::new();
    let mut processed_since_emit = 0_usize;
    let mut emitted_processing = false;
    loop {
        let pick_result = with_queue_lock(root, || {
            let mut queue = read_queue(root)?;
            let Some(idx) = queue.tasks.iter().position(|task| {
                task.project_id == project_id && task.status == FileChangeStatus::Pending
            }) else {
                return Ok(None);
            };

            queue.tasks[idx].status = FileChangeStatus::Processing;
            queue.tasks[idx].updated_at = now_ms();
            let task = queue.tasks[idx].clone();
            write_queue(root, &queue)?;
            Ok(Some((task, queue)))
        });
        let picked = match pick_result {
            Ok(result) => result,
            Err(err) => {
                on_changed(changed_tasks);
                return Err(err);
            }
        };
        let Some((task, queue)) = picked else {
            let queue = match with_queue_lock(root, || read_queue(root)) {
                Ok(queue) => queue,
                Err(err) => {
                    on_changed(changed_tasks);
                    return Err(err);
                }
            };
            on_changed(changed_tasks);
            on_queue(&queue);
            return Ok(all_changed_tasks);
        };
        if !emitted_processing {
            emitted_processing = true;
            on_queue(&queue);
        }

        let meta_result = read_meta(root, &task.path);
        let mut emit_after_update = false;
        let update_result = with_queue_lock(root, || {
            let mut queue = read_queue(root)?;
            if let Some(current) = queue.tasks.iter_mut().find(|t| t.id == task.id) {
                if current.status != FileChangeStatus::Processing
                    || current.updated_at != task.updated_at
                {
                    if current.status == FileChangeStatus::Processing && current.needs_rerun {
                        current.status = FileChangeStatus::Pending;
                        current.needs_rerun = false;
                        current.updated_at = now_ms();
                    }
                } else {
                    match meta_result {
                        Ok(meta) => {
                            write_task_meta_to_snapshot(root, &task, meta)?;
                            if current.needs_rerun {
                                current.status = FileChangeStatus::Pending;
                                current.needs_rerun = false;
                            } else {
                                current.status = FileChangeStatus::Done;
                            }
                            current.error = None;
                        }
                        Err(err) => {
                            current.status = FileChangeStatus::Failed;
                            current.error = Some(err);
                            current.retry_count += 1;
                        }
                    }
                    current.updated_at = now_ms();
                    all_changed_tasks.push(task.clone());
                    changed_tasks.push(task.clone());
                    processed_since_emit += 1;
                    if processed_since_emit >= QUEUE_EMIT_EVERY {
                        processed_since_emit = 0;
                        emit_after_update = true;
                    }
                }
            }
            queue
                .tasks
                .retain(|task| task.status != FileChangeStatus::Done);
            write_queue(root, &queue)?;
            read_queue(root)
        });
        let queue = match update_result {
            Ok(queue) => queue,
            Err(err) => {
                on_changed(changed_tasks);
                return Err(err);
            }
        };
        if emit_after_update {
            on_queue(&queue);
        }
    }
}

#[cfg(test)]
fn apply_task_to_snapshot(root: &Path, task: &FileChangeTask) -> Result<(), String> {
    let meta = read_meta(root, &task.path)?;
    with_queue_lock(root, || write_task_meta_to_snapshot(root, task, meta))
}

fn write_task_meta_to_snapshot(
    root: &Path,
    task: &FileChangeTask,
    meta: Option<FileMeta>,
) -> Result<(), String> {
    let mut snapshot = read_snapshot(root)?;
    match meta {
        Some(meta) => {
            snapshot.files.insert(task.path.clone(), meta);
        }
        None => {
            snapshot.files.remove(&task.path);
        }
    }
    snapshot.version = 1;
    snapshot.updated_at = now_ms();
    write_snapshot(root, &snapshot)
}

fn reset_processing_tasks(root: &Path, project_id: &str) -> Result<(), String> {
    let mut queue = read_queue(root)?;
    let mut changed = false;
    queue.tasks.retain(|task| task.project_id == project_id);
    for task in &mut queue.tasks {
        if task.status == FileChangeStatus::Processing {
            task.status = FileChangeStatus::Pending;
            task.needs_rerun = false;
            task.error = None;
            task.updated_at = now_ms();
            changed = true;
        }
    }
    if changed {
        write_queue(root, &queue)?;
    }
    Ok(())
}

fn read_meta(root: &Path, rel: &str) -> Result<Option<FileMeta>, String> {
    let path = root.join(rel);
    if !path.exists() {
        return Ok(None);
    }
    let meta = fs::metadata(&path).map_err(|e| format!("metadata failed for {rel}: {e}"))?;
    if !meta.is_file() {
        return Ok(None);
    }
    let size = meta.len();
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let hash = if size <= MAX_HASH_BYTES {
        Some(md5_file(&path)?)
    } else {
        None
    };
    Ok(Some(FileMeta {
        hash,
        size,
        mtime_ms,
    }))
}

fn read_meta_fast(root: &Path, rel: &str) -> Result<Option<FileMeta>, String> {
    let path = root.join(rel);
    if !path.exists() {
        return Ok(None);
    }
    let meta = fs::metadata(&path).map_err(|e| format!("metadata failed for {rel}: {e}"))?;
    if !meta.is_file() {
        return Ok(None);
    }
    let size = meta.len();
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Ok(Some(FileMeta {
        hash: None,
        size,
        mtime_ms,
    }))
}

fn md5_file(path: &Path) -> Result<String, String> {
    let mut file =
        fs::File::open(path).map_err(|e| format!("open failed for '{}': {e}", path.display()))?;
    let mut hasher = Md5::new();
    let mut buf = [0_u8; 64 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("read failed for '{}': {e}", path.display()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn relative_watch_path(
    root: &Path,
    path: &Path,
    rules: &SourceWatchRules,
    size: Option<u64>,
) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let rel = normalize_rel_path(rel)?;
    if !should_watch_rel(&rel, rules) {
        return None;
    }
    if rel.starts_with("raw/sources/") && path.exists() {
        let max_bytes = rules.config.max_file_size_mb.saturating_mul(1024 * 1024);
        let size = size.or_else(|| fs::metadata(path).ok().map(|m| m.len()))?;
        if size > max_bytes {
            return None;
        }
    }
    Some(rel)
}

fn normalize_rel_path(path: &Path) -> Option<String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(s) => parts.push(s.to_string_lossy().to_string()),
            Component::CurDir => {}
            _ => return None,
        }
    }
    Some(parts.join("/"))
}

fn should_watch_rel(rel: &str, rules: &SourceWatchRules) -> bool {
    if rel.is_empty() {
        return false;
    }
    let lower = rel.to_lowercase();
    if lower.contains("/.llm-wiki/")
        || lower.starts_with(".llm-wiki/")
        // App-managed generated media is intentionally ignored here. The
        // source markdown references drive graph/index refresh; media bytes
        // themselves are not analyzed by the wiki pipeline.
        || lower.starts_with("wiki/media/")
        || lower.ends_with(".ds_store")
    {
        return false;
    }
    let name = lower.rsplit('/').next().unwrap_or(&lower);
    if name == "thumbs.db" || name == "desktop.ini" {
        return false;
    }
    if rules.matches_excluded_dir(&lower) {
        return false;
    }
    if rules
        .exclude_globs
        .iter()
        .any(|pattern| wildcard_match(pattern, rel) || wildcard_match(pattern, name))
    {
        return false;
    }
    if rel.starts_with("raw/sources/") {
        let ext = extension_of(name);
        if !ext.is_empty()
            && rules.exclude_extensions.contains(ext)
        {
            return false;
        }
        if !rules.include_extensions.is_empty()
            && (ext.is_empty() || !rules.include_extensions.contains(ext))
        {
            return false;
        }
        return true;
    }
    rel == "purpose.md"
        || rel == "schema.md"
        || (rel.starts_with("wiki/") && rel.ends_with(".md"))
}

struct SourceWatchRules<'a> {
    config: &'a SourceWatchConfig,
    include_extensions: BTreeSet<String>,
    exclude_extensions: BTreeSet<String>,
    exclude_dirs: BTreeSet<String>,
    exclude_globs: Vec<String>,
}

impl<'a> SourceWatchRules<'a> {
    fn new(config: &'a SourceWatchConfig) -> Self {
        Self {
            config,
            include_extensions: config.include_extensions.iter().cloned().collect(),
            exclude_extensions: config.exclude_extensions.iter().cloned().collect(),
            exclude_dirs: config
                .exclude_dirs
                .iter()
                .map(|dir| normalize_rel_string(dir).to_lowercase())
                .filter(|dir| !dir.is_empty())
                .collect(),
            exclude_globs: config.exclude_globs.iter().cloned().collect(),
        }
    }

    fn matches_excluded_dir(&self, rel_lower: &str) -> bool {
        self.exclude_dirs.iter().any(|dir| {
            if dir.contains('/') {
                rel_lower == dir
                    || rel_lower.starts_with(&format!("{dir}/"))
                    || rel_lower.contains(&format!("/{dir}/"))
            } else {
                rel_lower.split('/').any(|part| part == dir)
            }
        })
    }
}

fn normalize_rel_string(value: &str) -> String {
    value.replace('\\', "/").trim_matches('/').to_string()
}

fn extension_of(name: &str) -> &str {
    name.rsplit_once('.').map(|(_, ext)| ext).unwrap_or("")
}

fn normalize_ext_list(values: Vec<String>) -> Vec<String> {
    values
        .into_iter()
        .map(|value| value.trim().trim_start_matches('.').to_lowercase())
        .filter(|value| !value.is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn normalize_string_list(values: Vec<String>) -> Vec<String> {
    values
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn wildcard_match(pattern: &str, value: &str) -> bool {
    let pattern = pattern.to_lowercase().chars().collect::<Vec<_>>();
    let value = value.to_lowercase().chars().collect::<Vec<_>>();
    wildcard_match_inner(&pattern, &value)
}

fn wildcard_match_inner(pattern: &[char], value: &[char]) -> bool {
    let (mut p, mut v) = (0usize, 0usize);
    let mut star: Option<usize> = None;
    let mut match_after_star = 0usize;
    while v < value.len() {
        if p < pattern.len() && (pattern[p] == '?' || pattern[p] == value[v]) {
            p += 1;
            v += 1;
        } else if p < pattern.len() && pattern[p] == '*' {
            star = Some(p);
            match_after_star = v;
            p += 1;
        } else if let Some(star_pos) = star {
            p = star_pos + 1;
            match_after_star += 1;
            v = match_after_star;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == '*' {
        p += 1;
    }
    p == pattern.len()
}

fn merge_kind(existing: &FileChangeKind, incoming: &FileChangeKind) -> FileChangeKind {
    match (existing, incoming) {
        (FileChangeKind::Deleted, FileChangeKind::Created)
        | (FileChangeKind::Created, FileChangeKind::Deleted)
        | (_, FileChangeKind::Modified) => FileChangeKind::Modified,
        (_, kind) => kind.clone(),
    }
}

fn emit_queue(app: &AppHandle, project_id: &str, queue: &FileChangeQueue) {
    let payload = FileSyncPayload {
        project_id: project_id.to_string(),
        tasks: queue.tasks.clone(),
    };
    let _ = app.emit(EVENT_QUEUE_UPDATED, payload);
}

fn emit_changed_batch(app: &AppHandle, project_id: &str, tasks: Vec<FileChangeTask>) {
    if tasks.is_empty() {
        return;
    }
    let payload = FileSyncPayload {
        project_id: project_id.to_string(),
        tasks,
    };
    let _ = app.emit(EVENT_CHANGED, payload);
}

fn ensure_sync_dir(root: &Path) -> Result<(), String> {
    fs::create_dir_all(root.join(".llm-wiki"))
        .map_err(|e| format!("Failed to create .llm-wiki: {e}"))
}

fn read_snapshot(root: &Path) -> Result<FileSnapshot, String> {
    read_json(root.join(SNAPSHOT_FILE)).map(|mut s: FileSnapshot| {
        if s.version == 0 {
            s.version = 1;
        }
        s
    })
}

fn write_snapshot(root: &Path, snapshot: &FileSnapshot) -> Result<(), String> {
    write_json(root.join(SNAPSHOT_FILE), snapshot)
}

fn read_queue(root: &Path) -> Result<FileChangeQueue, String> {
    read_json(root.join(QUEUE_FILE)).map(|mut q: FileChangeQueue| {
        if q.version == 0 {
            q.version = 1;
        }
        q
    })
}

fn write_queue(root: &Path, queue: &FileChangeQueue) -> Result<(), String> {
    write_json(root.join(QUEUE_FILE), queue)
}

fn read_json<T>(path: PathBuf) -> Result<T, String>
where
    T: Default + for<'de> Deserialize<'de>,
{
    if !path.exists() {
        return Ok(T::default());
    }
    let text = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read '{}': {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("Failed to parse '{}': {e}", path.display()))
}

fn write_json<T: Serialize>(path: PathBuf, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create '{}': {e}", parent.display()))?;
    }
    let text =
        serde_json::to_string_pretty(value).map_err(|e| format!("JSON encode failed: {e}"))?;
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "file-sync.json".to_string());
    let tmp_path = path.with_file_name(format!(
        ".{file_name}.{}.tmp",
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_else(now_ms)
    ));
    fs::write(&tmp_path, text)
        .map_err(|e| format!("Failed to write '{}': {e}", tmp_path.display()))?;
    #[cfg(windows)]
    {
        if path.exists() {
            fs::remove_file(&path)
                .map_err(|e| format!("Failed to replace '{}': {e}", path.display()))?;
        }
    }
    fs::rename(&tmp_path, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        format!(
            "Failed to move '{}' to '{}': {e}",
            tmp_path.display(),
            path.display()
        )
    })
}

fn stable_path_hash(path: &str) -> String {
    let mut hasher = Md5::new();
    hasher.update(path.as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    digest[..12].to_string()
}

fn normalize_key(path: &str) -> String {
    if cfg!(windows) {
        path.to_lowercase()
    } else {
        path.to_string()
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn queue_lock_for(root: &Path) -> Arc<Mutex<()>> {
    let key = path_key(root);
    let mut locks = QUEUE_LOCKS
        .get_or_init(|| Mutex::new(BTreeMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    locks
        .entry(key)
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

fn with_queue_lock<T>(root: &Path, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let lock = queue_lock_for(root);
    let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    f()
}

fn path_key(path: &Path) -> String {
    if let Ok(canonical) = path.canonicalize() {
        return normalize_path_key(&canonical);
    }

    let mut existing = path.to_path_buf();
    let mut suffix = Vec::new();
    while !existing.exists() {
        let Some(name) = existing.file_name().map(|name| name.to_os_string()) else {
            return normalize_path_key(path);
        };
        suffix.push(name);
        if !existing.pop() {
            return normalize_path_key(path);
        }
    }

    let Ok(mut canonical) = existing.canonicalize() else {
        return normalize_path_key(path);
    };
    for part in suffix.iter().rev() {
        canonical.push(part);
    }
    normalize_path_key(&canonical)
}

fn normalize_path_key(path: &Path) -> String {
    normalize_key(&path.to_string_lossy().replace('\\', "/"))
}

fn is_app_write_ignored(path: &Path) -> bool {
    let key = path_key(path);
    let now = now_ms();
    let mut ignores = APP_WRITE_IGNORES
        .get_or_init(|| Mutex::new(BTreeMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    ignores.retain(|_, expires_at| *expires_at > now);
    ignores
        .keys()
        .any(|ignored| key == *ignored || key.starts_with(&format!("{ignored}/")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("llm-wiki-file-sync-{name}-{stamp}"));
        fs::create_dir_all(root.join("raw/sources")).unwrap();
        root
    }

    fn default_watch_config() -> SourceWatchConfig {
        SourceWatchConfig::default()
    }

    #[test]
    fn md5_detects_same_size_content_changes() {
        let root = temp_root("same-size");
        let rel = "raw/sources/a.md";
        fs::write(root.join(rel), "aaaa").unwrap();

        ensure_sync_dir(&root).unwrap();
        enqueue_rescan_changes(&root, "p1", &default_watch_config()).unwrap();
        let first = read_queue(&root).unwrap().tasks[0].clone();
        apply_task_to_snapshot(&root, &first).unwrap();
        write_queue(
            &root,
            &FileChangeQueue {
                version: 1,
                tasks: vec![],
            },
        )
        .unwrap();

        fs::write(root.join(rel), "bbbb").unwrap();
        enqueue_paths(&root, "p1", BTreeSet::from([rel.to_string()])).unwrap();
        let queue = read_queue(&root).unwrap();

        assert_eq!(queue.tasks.len(), 1);
        assert_eq!(queue.tasks[0].kind, FileChangeKind::Modified);
        assert_ne!(queue.tasks[0].hash_before, queue.tasks[0].hash_after);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn repeated_changes_upsert_one_pending_task() {
        let root = temp_root("dedupe");
        let rel = "raw/sources/a.md";
        fs::write(root.join(rel), "one").unwrap();

        ensure_sync_dir(&root).unwrap();
        enqueue_paths(&root, "p1", BTreeSet::from([rel.to_string()])).unwrap();
        fs::write(root.join(rel), "two").unwrap();
        enqueue_paths(&root, "p1", BTreeSet::from([rel.to_string()])).unwrap();

        let queue = read_queue(&root).unwrap();
        assert_eq!(queue.tasks.len(), 1);
        assert_eq!(queue.tasks[0].status, FileChangeStatus::Pending);
        assert_eq!(queue.tasks[0].path, rel);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn directory_delete_expands_snapshot_children() {
        let root = temp_root("dir-delete");
        let a = "raw/sources/folder/a.md";
        let b = "raw/sources/folder/b.md";
        fs::create_dir_all(root.join("raw/sources/folder")).unwrap();
        fs::write(root.join(a), "a").unwrap();
        fs::write(root.join(b), "b").unwrap();

        ensure_sync_dir(&root).unwrap();
        sync_snapshot_paths(&root, BTreeSet::from([a.to_string(), b.to_string()])).unwrap();
        fs::remove_dir_all(root.join("raw/sources/folder")).unwrap();

        let mut rels = BTreeSet::new();
        let snapshot = read_snapshot(&root).unwrap();
        let config = default_watch_config();
        let rules = SourceWatchRules::new(&config);
        collect_known_paths(
            &root,
            &root.join("raw/sources/folder"),
            &snapshot,
            &mut rels,
            &rules,
        );

        assert_eq!(rels, BTreeSet::from([a.to_string(), b.to_string()]));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn prefix_rescan_detects_raw_source_mount_style_changes() {
        let root = temp_root("prefix-rescan");
        let old = "raw/sources/old.md";
        let new = "raw/sources/new.md";
        fs::write(root.join(old), "old").unwrap();

        ensure_sync_dir(&root).unwrap();
        sync_snapshot_paths(&root, BTreeSet::from([old.to_string()])).unwrap();
        fs::remove_file(root.join(old)).unwrap();
        fs::write(root.join(new), "new").unwrap();

        enqueue_rescan_changes_for_prefixes(&root, "p1", &["raw/sources"], &default_watch_config()).unwrap();
        let queue = read_queue(&root).unwrap();
        let by_path = queue
            .tasks
            .iter()
            .map(|task| (task.path.as_str(), task.kind.clone()))
            .collect::<BTreeMap<_, _>>();

        assert_eq!(by_path.get(old), Some(&FileChangeKind::Deleted));
        assert_eq!(by_path.get(new), Some(&FileChangeKind::Created));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn app_written_paths_update_snapshot_without_queueing() {
        let root = temp_root("app-write");
        let rel = "raw/sources/a.md";
        let path = root.join(rel);
        fs::write(&path, "old").unwrap();

        ensure_sync_dir(&root).unwrap();
        sync_snapshot_paths(&root, BTreeSet::from([rel.to_string()])).unwrap();
        fs::write(&path, "new").unwrap();
        mark_app_write_path(&path);

        let mut app_written_rels = BTreeSet::new();
        let snapshot = read_snapshot(&root).unwrap();
        if is_app_write_ignored(&path) {
            let config = default_watch_config();
            let rules = SourceWatchRules::new(&config);
            collect_known_paths(&root, &path, &snapshot, &mut app_written_rels, &rules);
        }
        sync_snapshot_paths(&root, app_written_rels).unwrap();

        let queue = read_queue(&root).unwrap();
        let snapshot = read_snapshot(&root).unwrap();
        assert!(queue.tasks.is_empty());
        assert_eq!(
            snapshot.files.get(rel).and_then(|m| m.hash.clone()),
            read_meta(&root, rel).unwrap().and_then(|m| m.hash)
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn retry_limit_keeps_failed_task_failed_on_new_changes() {
        let root = temp_root("retry-limit");
        let rel = "raw/sources/a.md";
        fs::write(root.join(rel), "one").unwrap();

        ensure_sync_dir(&root).unwrap();
        let mut queue = FileChangeQueue {
            version: 1,
            tasks: vec![FileChangeTask {
                id: "t1".into(),
                project_id: "p1".into(),
                path: rel.into(),
                kind: FileChangeKind::Modified,
                status: FileChangeStatus::Failed,
                hash_before: None,
                hash_after: None,
                size: None,
                mtime_ms: None,
                created_at: 1,
                updated_at: 1,
                retry_count: MAX_RETRY_COUNT,
                error: Some("failed".into()),
                needs_rerun: false,
            }],
        };
        upsert_task(
            &mut queue,
            "p1",
            rel,
            FileChangeKind::Modified,
            None,
            read_meta(&root, rel).unwrap(),
            now_ms(),
        );

        assert_eq!(queue.tasks.len(), 1);
        assert_eq!(queue.tasks[0].status, FileChangeStatus::Failed);
        assert_eq!(queue.tasks[0].retry_count, MAX_RETRY_COUNT);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn watch_rules_exclude_temporary_and_app_dirs() {
        let config = default_watch_config();
        let rules = SourceWatchRules::new(&config);
        assert!(should_watch_rel("raw/sources/document.docx", &rules));
        assert!(should_watch_rel("wiki/concepts/topic.md", &rules));
        assert!(!should_watch_rel(".llm-wiki/file-change-queue.json", &rules));
        assert!(!should_watch_rel("raw/sources/~$Document.docx", &rules));
        assert!(!should_watch_rel("raw/sources/.~lock.Document.odt#", &rules));
        assert!(!should_watch_rel("raw/sources/Thumbs.db", &rules));
        assert!(!should_watch_rel("raw/sources/desktop.ini", &rules));
        assert!(!should_watch_rel("raw/sources/download.crdownload", &rules));
        assert!(!should_watch_rel(".vscode/settings.json", &rules));
        assert!(!should_watch_rel("wiki/media/image.png", &rules));
    }

    #[test]
    fn source_watch_config_filters_raw_source_extensions_and_dirs() {
        let config = SourceWatchConfig {
            include_extensions: vec!["md".into(), "pdf".into()],
            exclude_dirs: vec!["drafts".into(), "subdir/drafts".into()],
            exclude_globs: vec!["*.private.*".into()],
            ..SourceWatchConfig::default()
        };
        let config = normalize_source_watch_config(Some(config));
        let rules = SourceWatchRules::new(&config);

        assert!(should_watch_rel("raw/sources/final.md", &rules));
        assert!(!should_watch_rel("raw/sources/data.json", &rules));
        assert!(!should_watch_rel("raw/sources/drafts/final.md", &rules));
        assert!(!should_watch_rel("raw/sources/subdir/drafts/final.md", &rules));
        assert!(!should_watch_rel("raw/sources/report.private.md", &rules));
        assert!(should_watch_rel("wiki/index.md", &rules));
    }

    #[test]
    fn source_watch_config_skips_oversized_raw_sources() {
        let root = temp_root("max-size");
        let rel = "raw/sources/large.md";
        fs::write(root.join(rel), vec![b'x'; 2 * 1024 * 1024]).unwrap();
        let config = SourceWatchConfig {
            max_file_size_mb: 1,
            ..SourceWatchConfig::default()
        };
        let config = normalize_source_watch_config(Some(config));
        let rules = SourceWatchRules::new(&config);

        assert_eq!(relative_watch_path(&root, &root.join(rel), &rules, None), None);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn source_watch_defaults_are_loaded_from_shared_json_and_tolerate_missing_fields() {
        let default = SourceWatchConfig::default();
        assert!(default.include_extensions.contains(&"md".to_string()));
        assert!(default.exclude_dirs.contains(&".git".to_string()));

        let partial: SourceWatchConfig =
            serde_json::from_str(r#"{"enabled":false,"includeExtensions":["md"]}"#).unwrap();
        assert!(!partial.enabled);
        assert!(partial.auto_ingest);
        assert!(partial.exclude_dirs.contains(&".git".to_string()));
    }

    #[test]
    fn wildcard_match_is_unicode_character_based() {
        assert!(wildcard_match("?稿.md", "草稿.md"));
        assert!(wildcard_match("草*.md", "草稿文件.md"));
        assert!(!wildcard_match("??.md", "草稿文件.md"));
    }

    #[test]
    fn normalize_rel_path_tolerates_current_dir_segments() {
        let path = Path::new("raw").join(".").join("sources").join("doc.md");
        assert_eq!(
            normalize_rel_path(&path),
            Some("raw/sources/doc.md".to_string())
        );
    }

    #[test]
    fn queue_lock_recovers_after_poison() {
        let root = temp_root("poison");
        let lock = queue_lock_for(&root);
        let _ = std::thread::spawn(move || {
            let _guard = lock.lock().unwrap();
            panic!("poison file sync lock");
        })
        .join();

        let result = with_queue_lock(&root, || Ok(42));
        assert_eq!(result.unwrap(), 42);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn concurrent_enqueue_paths_do_not_drop_tasks() {
        let root = temp_root("concurrent");
        ensure_sync_dir(&root).unwrap();
        let mut handles = Vec::new();
        for i in 0..16 {
            let root = root.clone();
            let rel = format!("raw/sources/{i}.md");
            fs::write(root.join(&rel), format!("content {i}")).unwrap();
            handles.push(std::thread::spawn(move || {
                enqueue_paths(&root, "p1", BTreeSet::from([rel])).unwrap();
            }));
        }
        for handle in handles {
            handle.join().unwrap();
        }

        let queue = with_queue_lock(&root, || read_queue(&root)).unwrap();
        assert_eq!(queue.tasks.len(), 16);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn path_key_is_stable_after_leaf_deletion() {
        let root = temp_root("path-key");
        let path = root.join("raw/sources/a.md");
        fs::write(&path, "content").unwrap();
        let before = path_key(&path);
        fs::remove_file(&path).unwrap();
        let after = path_key(&path);

        assert_eq!(before, after);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    #[cfg(windows)]
    fn windows_path_key_is_case_insensitive() {
        assert_eq!(
            normalize_path_key(Path::new(r"C:\Proj\raw\sources\File.md")),
            normalize_path_key(Path::new(r"c:\proj\RAW\sources\file.md"))
        );
    }

    #[test]
    fn process_queue_updates_snapshot_and_removes_done_tasks() {
        let root = temp_root("process-e2e");
        let rel = "raw/sources/a.md";
        fs::write(root.join(rel), "content").unwrap();

        ensure_sync_dir(&root).unwrap();
        enqueue_paths(&root, "p1", BTreeSet::from([rel.to_string()])).unwrap();

        let mut queue_emits = 0;
        let mut changed_emits = 0;
        process_queue_inner(
            &root,
            "p1",
            |_| queue_emits += 1,
            |tasks| {
                if !tasks.is_empty() {
                    changed_emits += 1;
                }
            },
        )
        .unwrap();

        let queue = with_queue_lock(&root, || read_queue(&root)).unwrap();
        let snapshot = with_queue_lock(&root, || read_snapshot(&root)).unwrap();
        assert!(queue.tasks.is_empty());
        assert!(snapshot.files.contains_key(rel));
        assert!(queue_emits >= 1);
        assert_eq!(changed_emits, 1);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn process_queue_flushes_changed_tasks_before_returning_error() {
        let root = temp_root("flush-on-error");
        ensure_sync_dir(&root).unwrap();
        let rels = (0..26)
            .map(|i| {
                let rel = format!("raw/sources/{i}.md");
                fs::write(root.join(&rel), format!("content {i}")).unwrap();
                rel
            })
            .collect::<BTreeSet<_>>();
        enqueue_paths(&root, "p1", rels).unwrap();

        let snapshot_path = root.join(SNAPSHOT_FILE);
        let mut queue_emits = 0;
        let mut changed_count = 0;
        let result = process_queue_inner(
            &root,
            "p1",
            |_| {
                queue_emits += 1;
                if queue_emits == 2 {
                    fs::remove_file(&snapshot_path).unwrap();
                    fs::create_dir_all(&snapshot_path).unwrap();
                }
            },
            |tasks| changed_count += tasks.len(),
        );

        assert!(result.is_err());
        assert_eq!(changed_count, QUEUE_EMIT_EVERY);

        let _ = fs::remove_dir_all(root);
    }
}
