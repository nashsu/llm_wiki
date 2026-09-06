//! Background scheduler: runs enabled connectors whose interval has elapsed.
//!
//! Lives in the backend (not the webview) so syncs keep running on a
//! headless server with no browser attached, and in the desktop app while
//! another project is open. Files land in `raw/sources/`; the project's
//! source-folder watcher / startup rescan turns them into ingest work
//! whenever that project is (next) open.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use super::{now_ms, store, sync};
use crate::app_ctx::AppCtx;

static STARTED: AtomicBool = AtomicBool::new(false);
const TICK: Duration = Duration::from_secs(60);

/// Start the loop once per process.
pub fn start(ctx: AppCtx) {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    crate::rt::spawn(async move {
        // Let the app finish booting before the first pass.
        tokio::time::sleep(Duration::from_secs(20)).await;
        loop {
            run_due(&ctx).await;
            tokio::time::sleep(TICK).await;
        }
    });
}

/// One scheduler pass over every known project.
pub async fn run_due(ctx: &AppCtx) {
    let projects = crate::app_commands::load_agent_projects(ctx);
    for project in projects {
        let project_path = Path::new(&project.path);
        if !project_path.join(".llm-wiki").join("connectors.json").is_file() {
            continue;
        }
        for instance in store::list_instances(project_path) {
            if !is_due(&instance) || sync::is_running(&project.id, &instance.id) {
                continue;
            }
            match sync::run_sync(ctx, &project.id, project_path, &instance.id).await {
                Ok(report) => eprintln!(
                    "[connectors] {} / {}: +{} ~{} -{} (skipped {})",
                    project.name,
                    instance.name,
                    report.summary.added,
                    report.summary.updated,
                    report.summary.deleted,
                    report.summary.skipped
                ),
                Err(err) => eprintln!("[connectors] {} / {} failed: {err}", project.name, instance.name),
            }
        }
    }
}

fn is_due(instance: &super::ConnectorInstance) -> bool {
    if !instance.enabled || instance.interval_minutes == 0 {
        return false;
    }
    let interval_ms = i64::from(instance.interval_minutes) * 60_000;
    match &instance.last_sync {
        None => true,
        Some(last) => now_ms() - last.finished_at >= interval_ms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::{ConnectorInstance, SyncSummary};
    use serde_json::Map;

    fn instance(enabled: bool, interval: u32, finished_ago_ms: Option<i64>) -> ConnectorInstance {
        ConnectorInstance {
            id: "i".into(),
            kind: "local-folder".into(),
            name: "n".into(),
            enabled,
            interval_minutes: interval,
            config: Map::new(),
            max_file_size_mb: 0,
            created_at: 0,
            last_sync: finished_ago_ms.map(|ago| SyncSummary {
                finished_at: now_ms() - ago,
                ..Default::default()
            }),
        }
    }

    #[test]
    fn due_rules() {
        assert!(!is_due(&instance(false, 5, None)));
        assert!(!is_due(&instance(true, 0, None)));
        assert!(is_due(&instance(true, 5, None)));
        assert!(!is_due(&instance(true, 5, Some(60_000))));
        assert!(is_due(&instance(true, 5, Some(6 * 60_000))));
    }
}
