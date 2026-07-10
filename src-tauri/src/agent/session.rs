use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

const MAX_SESSION_MESSAGES: usize = 40;
// Bound only the in-memory cache. Session files stay on disk so API/MCP callers
// can resume old conversations without the desktop UI keeping every session hot.
const MAX_CACHED_SESSIONS: usize = 128;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionMessage {
    pub role: String,
    pub content: String,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub project_id: String,
    pub messages: Vec<AgentSessionMessage>,
    pub updated_at: u64,
}

#[derive(Debug, Default)]
pub struct AgentSessionStore {
    inner: Mutex<BTreeMap<String, AgentSession>>,
}

impl AgentSessionStore {
    pub fn append_turn(
        &self,
        project_path: &str,
        project_id: &str,
        session_id: &str,
        user: &str,
        assistant: &str,
    ) {
        let now = now_ms();
        let Ok(mut guard) = self.inner.lock() else {
            return;
        };
        let cache_key = session_cache_key(project_path, session_id);
        let session = guard
            .entry(cache_key)
            .or_insert_with(|| load_session(project_path, session_id).unwrap_or_default());
        session.session_id = session_id.to_string();
        session.project_id = project_id.to_string();
        session.messages.push(AgentSessionMessage {
            role: "user".to_string(),
            content: user.to_string(),
            timestamp: now,
        });
        session.messages.push(AgentSessionMessage {
            role: "assistant".to_string(),
            content: assistant.to_string(),
            timestamp: now,
        });
        if session.messages.len() > MAX_SESSION_MESSAGES {
            let drop_count = session.messages.len() - MAX_SESSION_MESSAGES;
            session.messages.drain(0..drop_count);
        }
        session.updated_at = now;
        let _ = save_session(project_path, session);
        trim_session_cache(&mut guard);
    }

    pub fn recent_messages(
        &self,
        project_path: &str,
        session_id: &str,
        limit: usize,
    ) -> Vec<AgentSessionMessage> {
        let session = self
            .inner
            .lock()
            .ok()
            .and_then(|mut guard| {
                let cache_key = session_cache_key(project_path, session_id);
                if !guard.contains_key(&cache_key) {
                    if let Some(loaded) = load_session(project_path, session_id) {
                        guard.insert(cache_key.clone(), loaded);
                        trim_session_cache(&mut guard);
                    }
                }
                guard.get(&cache_key).cloned()
            })
            .or_else(|| load_session(project_path, session_id));
        let Some(session) = session else {
            return Vec::new();
        };
        let start = session.messages.len().saturating_sub(limit);
        session.messages[start..].to_vec()
    }

    pub fn list_sessions(&self, project_path: &str) -> Vec<AgentSession> {
        let dir = Path::new(project_path)
            .join(".llm-wiki")
            .join("agent-sessions");
        let Ok(entries) = fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut sessions = entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                if entry.path().extension().and_then(|s| s.to_str()) != Some("json") {
                    return None;
                }
                let raw = fs::read_to_string(entry.path()).ok()?;
                serde_json::from_str::<AgentSession>(&raw).ok()
            })
            .collect::<Vec<_>>();
        sessions.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| b.session_id.cmp(&a.session_id))
        });
        sessions
    }
}

fn session_cache_key(project_path: &str, session_id: &str) -> String {
    format!("{}::{session_id}", normalize_project_path(project_path))
}

fn normalize_project_path(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').to_string()
}

fn trim_session_cache(cache: &mut BTreeMap<String, AgentSession>) {
    if cache.len() <= MAX_CACHED_SESSIONS {
        return;
    }
    let mut entries = cache
        .iter()
        .map(|(key, session)| (key.clone(), session.updated_at))
        .collect::<Vec<_>>();
    entries.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
    let remove_count = cache.len().saturating_sub(MAX_CACHED_SESSIONS);
    for (key, _) in entries.into_iter().take(remove_count) {
        cache.remove(&key);
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn load_session(project_path: &str, session_id: &str) -> Option<AgentSession> {
    let path = session_file(project_path, session_id)?;
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn save_session(project_path: &str, session: &AgentSession) -> Result<(), String> {
    let path = session_file(project_path, &session.session_id)
        .ok_or_else(|| "Invalid Agent session id".to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("Failed to create session dir: {err}"))?;
    }
    let raw = serde_json::to_string_pretty(session)
        .map_err(|err| format!("Failed to serialize session: {err}"))?;
    fs::write(path, raw).map_err(|err| format!("Failed to write session: {err}"))
}

fn session_file(project_path: &str, session_id: &str) -> Option<PathBuf> {
    let id = sanitize_session_id(session_id)?;
    Some(
        Path::new(project_path)
            .join(".llm-wiki")
            .join("agent-sessions")
            .join(format!("{id}.json")),
    )
}

fn sanitize_session_id(session_id: &str) -> Option<String> {
    let trimmed = session_id.trim();
    if trimmed.is_empty()
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains("..")
        || trimmed.len() > 128
    {
        return None;
    }
    Some(
        trimmed
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                    ch
                } else {
                    '_'
                }
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use uuid::Uuid;

    use super::*;

    fn temp_project(name: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("llm-wiki-agent-session-{name}-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn append_turn_tracks_recent_messages() {
        let project = temp_project("recent");
        let store = AgentSessionStore::default();
        store.append_turn(project.to_str().unwrap(), "p1", "s1", "hello", "hi");
        store.append_turn(project.to_str().unwrap(), "p1", "s1", "question", "answer");

        let messages = store.recent_messages(project.to_str().unwrap(), "s1", 3);
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0].content, "hi");
        assert_eq!(messages[1].role, "user");
        assert_eq!(messages[2].content, "answer");
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn recent_messages_returns_empty_for_missing_session() {
        let project = temp_project("missing");
        let store = AgentSessionStore::default();
        assert!(store
            .recent_messages(project.to_str().unwrap(), "missing", 10)
            .is_empty());
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn append_turn_persists_session_to_project_state_dir() {
        let project = temp_project("persist");
        let store = AgentSessionStore::default();
        store.append_turn(project.to_str().unwrap(), "p1", "s.persist", "hello", "hi");

        let fresh = AgentSessionStore::default();
        let messages = fresh.recent_messages(project.to_str().unwrap(), "s.persist", 10);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].content, "hello");
        assert!(project
            .join(".llm-wiki")
            .join("agent-sessions")
            .join("s.persist.json")
            .exists());
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn session_cache_is_bounded() {
        let project = temp_project("bounded");
        let store = AgentSessionStore::default();
        for idx in 0..(MAX_CACHED_SESSIONS + 5) {
            store.append_turn(
                project.to_str().unwrap(),
                "p1",
                &format!("s{idx:03}"),
                "hello",
                "hi",
            );
        }
        let guard = store.inner.lock().unwrap();
        assert!(guard.len() <= MAX_CACHED_SESSIONS);
        let _ = fs::remove_dir_all(project);
    }

    #[test]
    fn same_session_id_is_isolated_by_project() {
        let project_a = temp_project("isolate-a");
        let project_b = temp_project("isolate-b");
        let store = AgentSessionStore::default();
        store.append_turn(
            project_a.to_str().unwrap(),
            "p1",
            "same",
            "hello a",
            "answer a",
        );
        store.append_turn(
            project_b.to_str().unwrap(),
            "p2",
            "same",
            "hello b",
            "answer b",
        );

        let a_messages = store.recent_messages(project_a.to_str().unwrap(), "same", 10);
        let b_messages = store.recent_messages(project_b.to_str().unwrap(), "same", 10);

        assert_eq!(a_messages.len(), 2);
        assert_eq!(a_messages[0].content, "hello a");
        assert_eq!(a_messages[1].content, "answer a");
        assert_eq!(b_messages.len(), 2);
        assert_eq!(b_messages[0].content, "hello b");
        assert_eq!(b_messages[1].content, "answer b");
        let _ = fs::remove_dir_all(project_a);
        let _ = fs::remove_dir_all(project_b);
    }

    #[test]
    fn session_ids_reject_path_traversal() {
        assert!(session_file("/tmp/project", "../secret").is_none());
        assert!(session_file("/tmp/project", "safe-id").is_some());
    }

    #[test]
    fn list_sessions_returns_persisted_sessions_newest_first() {
        let project = temp_project("list");
        let store = AgentSessionStore::default();
        store.append_turn(project.to_str().unwrap(), "p1", "s1", "one", "a");
        store.append_turn(project.to_str().unwrap(), "p1", "s2", "two", "b");

        let sessions = store.list_sessions(project.to_str().unwrap());
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].session_id, "s2");
        assert_eq!(sessions[1].session_id, "s1");
        let _ = fs::remove_dir_all(project);
    }
}
