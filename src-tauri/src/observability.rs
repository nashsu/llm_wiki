//! Structured JSON logs on stderr for local debugging and log aggregation.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};

static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(0);

pub fn next_request_id() -> String {
    let n = REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("req-{n}")
}

pub fn log_event(
    level: &str,
    component: &str,
    event: &str,
    fields: &[(&str, &str)],
    request_id: Option<&str>,
) {
    let mut map = BTreeMap::new();
    map.insert("ts".to_string(), chrono::Utc::now().to_rfc3339());
    map.insert("level".to_string(), level.to_string());
    map.insert("component".to_string(), component.to_string());
    map.insert("event".to_string(), event.to_string());
    if let Some(id) = request_id {
        map.insert("requestId".to_string(), id.to_string());
    }
    for (k, v) in fields {
        map.insert((*k).to_string(), (*v).to_string());
    }
    if let Ok(line) = serde_json::to_string(&map) {
        eprintln!("{line}");
    }
}

pub fn log_info(component: &str, event: &str, fields: &[(&str, &str)]) {
    log_event("info", component, event, fields, None);
}

pub fn log_warn(component: &str, event: &str, fields: &[(&str, &str)]) {
    log_event("warn", component, event, fields, None);
}

pub fn log_error(component: &str, event: &str, fields: &[(&str, &str)]) {
    log_event("error", component, event, fields, None);
}
