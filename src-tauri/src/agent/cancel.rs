use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

// Cancellation is shared by Tauri commands and the local HTTP API. Keep the
// registry backend-owned so UI disconnects, API clients, and MCP clients all
// observe the same run cancellation semantics.
#[derive(Debug)]
pub struct AgentCancellationToken {
    cancelled: Arc<AtomicBool>,
    key: String,
    registry: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl AgentCancellationToken {
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }

    pub fn check(&self) -> Result<(), String> {
        if self.is_cancelled() {
            Err("Agent turn cancelled".to_string())
        } else {
            Ok(())
        }
    }

    pub async fn cancelled(&self) {
        while !self.is_cancelled() {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

impl Drop for AgentCancellationToken {
    fn drop(&mut self) {
        // Normal completion calls `finish`, but Drop is the safety net for
        // panics, early returns, and aborted tasks. The remove is idempotent.
        if let Ok(mut tokens) = self.registry.lock() {
            tokens.remove(&self.key);
        }
    }
}

#[derive(Debug, Default, Clone)]
pub struct AgentCancellationRegistry {
    tokens: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl AgentCancellationRegistry {
    pub fn start(
        &self,
        project_id: &str,
        session_id: &str,
        run_id: &str,
    ) -> AgentCancellationToken {
        let token = Arc::new(AtomicBool::new(false));
        let key = cancel_key(project_id, session_id, run_id);
        self.tokens
            .lock()
            .unwrap()
            .insert(key.clone(), token.clone());
        AgentCancellationToken {
            cancelled: token,
            key,
            registry: self.tokens.clone(),
        }
    }

    pub fn cancel(&self, project_id: &str, session_id: &str, run_id: Option<&str>) -> bool {
        let key_prefix = format!(
            "{}::{}::",
            normalize_key(project_id),
            normalize_key(session_id)
        );
        let token = {
            let tokens = self.tokens.lock().unwrap();
            if let Some(run_id) = run_id {
                tokens
                    .get(&cancel_key(project_id, session_id, run_id))
                    .cloned()
            } else {
                tokens
                    .iter()
                    .find(|(key, _)| key.starts_with(&key_prefix))
                    .map(|(_, token)| token.clone())
            }
        };
        let Some(token) = token else {
            return false;
        };
        token.store(true, Ordering::Relaxed);
        true
    }

    pub fn finish(&self, project_id: &str, session_id: &str, run_id: &str) {
        self.tokens
            .lock()
            .unwrap()
            .remove(&cancel_key(project_id, session_id, run_id));
    }
}

fn cancel_key(project_id: &str, session_id: &str, run_id: &str) -> String {
    format!(
        "{}::{}::{}",
        normalize_key(project_id),
        normalize_key(session_id),
        normalize_key(run_id)
    )
}

fn normalize_key(value: &str) -> String {
    value.replace(['\\', '/'], "_")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_registry_marks_active_session() {
        let registry = AgentCancellationRegistry::default();
        let token = registry.start("p1", "s1", "r1");
        assert!(!token.is_cancelled());
        assert!(registry.cancel("p1", "s1", Some("r1")));
        assert!(token.is_cancelled());
    }

    #[test]
    fn cancellation_registry_returns_false_for_missing_session() {
        let registry = AgentCancellationRegistry::default();
        assert!(!registry.cancel("p1", "missing", None));
    }

    #[test]
    fn cancellation_registry_isolates_projects_and_runs() {
        let registry = AgentCancellationRegistry::default();
        let p1 = registry.start("p1", "same", "r1");
        let p2 = registry.start("p2", "same", "r1");
        assert!(registry.cancel("p1", "same", Some("r1")));
        assert!(p1.is_cancelled());
        assert!(!p2.is_cancelled());

        let r2 = registry.start("p2", "same", "r2");
        registry.finish("p2", "same", "r1");
        assert!(registry.cancel("p2", "same", Some("r2")));
        assert!(r2.is_cancelled());
    }

    #[test]
    fn cancellation_token_drop_removes_registry_entry() {
        let registry = AgentCancellationRegistry::default();
        {
            let _token = registry.start("p1", "s1", "r1");
            assert!(registry.cancel("p1", "s1", Some("r1")));
        }
        assert!(!registry.cancel("p1", "s1", Some("r1")));
    }
}
