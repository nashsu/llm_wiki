use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Read;
use std::panic::AssertUnwindSafe;
use std::path::{Component, Path, PathBuf};
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

static QUEUE_LOCKS: OnceLock<Mutex<BTreeMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
static APP_WRITE_IGNORES: OnceLock<Mutex<BTreeMap<String, i64>>> = OnceLock::new();

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
) -> Result<FileChangeQueue, String> {
    run_guarded("start_project_file_watcher", || {
        let root = PathBuf::from(project_path);
        ensure_sync_dir(&root)?;
        with_queue_lock(&root, || reset_processing_tasks(&root, &project_id))?;
        enqueue_rescan_changes(&root, &project_id)?;
        process_queue(&app, &root, &project_id)?;

        let (tx, rx) = mpsc::sync_channel::<PathBuf>(8_192);
        let app_for_thread = app.clone();
        let root_for_thread = root.clone();
        let project_for_thread = project_id.clone();
        std::thread::spawn(move || {
            let mut pending = BTreeSet::<PathBuf>::new();
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
                            continue;
                        }
                        let paths = pending.iter().cloned().collect::<Vec<_>>();
                        pending.clear();
                        let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
                            handle_changed_paths(
                                &app_for_thread,
                                &root_for_thread,
                                &project_for_thread,
                                paths,
                            )
                        }));
                        match result {
                            Ok(Ok(())) => {}
                            Ok(Err(err)) => eprintln!("[file-sync] change handling failed: {err}"),
                            Err(_) => eprintln!("[file-sync] watcher worker recovered from panic"),
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
        });

        let tx_for_watcher = tx.clone();
        let root_for_overflow = root.clone();
        let mut watcher = RecommendedWatcher::new(
            move |res: notify::Result<Event>| {
                if let Ok(event) = res {
                    for path in event.paths {
                        if tx_for_watcher.try_send(path).is_err() {
                            let _ = tx_for_watcher.try_send(root_for_overflow.clone());
                            break;
                        }
                    }
                }
            },
            Config::default(),
        )
        .map_err(|e| format!("Failed to create file watcher: {e}"))?;
        watcher
            .watch(&root, RecursiveMode::Recursive)
            .map_err(|e| format!("Failed to watch '{}': {e}", root.display()))?;

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
) -> Result<FileChangeQueue, String> {
    run_guarded("rescan_project_files", || {
        let root = PathBuf::from(project_path);
        ensure_sync_dir(&root)?;
        enqueue_rescan_changes(&root, &project_id)?;
        process_queue(&app, &root, &project_id)?;
        let queue = with_queue_lock(&root, || read_queue(&root))?;
        emit_queue(&app, &project_id, &queue);
        Ok(queue)
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
    paths: Vec<PathBuf>,
) -> Result<(), String> {
    let mut rels = BTreeSet::<String>::new();
    let mut app_written_rels = BTreeSet::<String>::new();
    let snapshot = with_queue_lock(root, || read_snapshot(root))?;
    for path in paths {
        if is_app_write_ignored(&path) {
            collect_known_paths(root, &path, &snapshot, &mut app_written_rels);
            continue;
        }
        if path.is_dir() {
            for entry in WalkDir::new(&path).into_iter().filter_map(Result::ok) {
                if entry.file_type().is_file() && !is_app_write_ignored(entry.path()) {
                    if let Some(rel) = relative_watch_path(root, entry.path()) {
                        rels.insert(rel);
                    }
                }
            }
        } else if let Some(rel) = relative_watch_path(root, &path) {
            rels.insert(rel);
        } else if !path.exists() {
            collect_known_paths(root, &path, &snapshot, &mut rels);
        }
    }
    if !app_written_rels.is_empty() {
        sync_snapshot_paths(root, app_written_rels)?;
    }
    if rels.is_empty() {
        return Ok(());
    }
    enqueue_paths(root, project_id, rels)?;
    process_queue(app, root, project_id)?;
    let queue = with_queue_lock(root, || read_queue(root))?;
    emit_queue(app, project_id, &queue);
    Ok(())
}

fn collect_known_paths(
    root: &Path,
    path: &Path,
    snapshot: &FileSnapshot,
    rels: &mut BTreeSet<String>,
) {
    if path.is_dir() {
        for entry in WalkDir::new(path).into_iter().filter_map(Result::ok) {
            if entry.file_type().is_file() {
                if let Some(rel) = relative_watch_path(root, entry.path()) {
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

    if should_watch_rel(&rel) {
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

fn enqueue_rescan_changes(root: &Path, project_id: &str) -> Result<(), String> {
    let mut rels = BTreeSet::<String>::new();
    for entry in WalkDir::new(root).into_iter().filter_map(Result::ok) {
        if entry.file_type().is_file() {
            if let Some(rel) = relative_watch_path(root, entry.path()) {
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

fn process_queue(app: &AppHandle, root: &Path, project_id: &str) -> Result<(), String> {
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
) -> Result<(), String> {
    let mut changed_tasks = Vec::<FileChangeTask>::new();
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
            return Ok(());
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

fn relative_watch_path(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let rel = normalize_rel_path(rel)?;
    if should_watch_rel(&rel) {
        Some(rel)
    } else {
        None
    }
}

fn normalize_rel_path(path: &Path) -> Option<String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(s) => parts.push(s.to_string_lossy().to_string()),
            _ => return None,
        }
    }
    Some(parts.join("/"))
}

fn should_watch_rel(rel: &str) -> bool {
    if rel.is_empty() {
        return false;
    }
    let lower = rel.to_lowercase();
    if lower.contains("/.llm-wiki/")
        || lower.starts_with(".llm-wiki/")
        || lower.starts_with(".cache/")
        || lower.starts_with(".obsidian/")
        || lower.starts_with(".idea/")
        || lower.starts_with(".vscode/")
        // App-managed generated media is intentionally ignored here. The
        // source markdown references drive graph/index refresh; media bytes
        // themselves are not analyzed by the wiki pipeline.
        || lower.starts_with("wiki/media/")
        || lower.ends_with(".tmp")
        || lower.ends_with(".swp")
        || lower.ends_with('~')
        || lower.ends_with(".ds_store")
        || lower.ends_with(".crdownload")
        || lower.ends_with(".part")
        || lower.ends_with(".partial")
    {
        return false;
    }
    let name = lower.rsplit('/').next().unwrap_or(&lower);
    if name.starts_with("~$") || (name.starts_with(".~lock.") && name.ends_with('#')) {
        return false;
    }
    rel == "purpose.md"
        || rel == "schema.md"
        || (rel.starts_with("wiki/") && rel.ends_with(".md"))
        || rel.starts_with("raw/sources/")
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
    fs::write(&path, text).map_err(|e| format!("Failed to write '{}': {e}", path.display()))
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
    path.to_string_lossy().replace('\\', "/")
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

    #[test]
    fn md5_detects_same_size_content_changes() {
        let root = temp_root("same-size");
        let rel = "raw/sources/a.md";
        fs::write(root.join(rel), "aaaa").unwrap();

        ensure_sync_dir(&root).unwrap();
        enqueue_rescan_changes(&root, "p1").unwrap();
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
        collect_known_paths(
            &root,
            &root.join("raw/sources/folder"),
            &snapshot,
            &mut rels,
        );

        assert_eq!(rels, BTreeSet::from([a.to_string(), b.to_string()]));

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
            collect_known_paths(&root, &path, &snapshot, &mut app_written_rels);
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
        assert!(should_watch_rel("raw/sources/doc.md"));
        assert!(should_watch_rel("wiki/concepts/topic.md"));
        assert!(!should_watch_rel(".llm-wiki/file-change-queue.json"));
        assert!(!should_watch_rel("raw/sources/~$Document.docx"));
        assert!(!should_watch_rel("raw/sources/.~lock.Document.odt#"));
        assert!(!should_watch_rel("raw/sources/download.crdownload"));
        assert!(!should_watch_rel(".vscode/settings.json"));
        assert!(!should_watch_rel("wiki/media/image.png"));
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
