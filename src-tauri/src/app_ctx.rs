//! Runtime-agnostic application context.
//!
//! Every backend entry point (Tauri IPC commands, the local HTTP API, the
//! clip server, and the web server) needs the same three things from the host
//! application: where persistent app data lives, a place to keep shared state
//! singletons, and a way to emit events to attached UIs. In the desktop build
//! those come from `tauri::AppHandle`; in the headless `llm-wiki-server`
//! build there is no Tauri runtime at all.
//!
//! `AppCtx` wraps both so the command layer can be written once. It is cheap
//! to clone (an `Arc`), and in the desktop build it also implements
//! `tauri::ipc::CommandArg`, so `#[tauri::command]` functions can simply take
//! a `ctx: AppCtx` parameter the same way they would take an `AppHandle`.

use std::any::{Any, TypeId};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use serde::Serialize;
use serde_json::Value;
use tokio::sync::broadcast;

/// Capacity of the broadcast channel that feeds web/SSE subscribers.
/// Slow subscribers that fall further behind than this simply skip events;
/// the frontend treats the event stream as advisory and re-reads state.
const EVENT_CHANNEL_CAPACITY: usize = 4096;

/// One event emitted through [`AppCtx::emit`], as delivered to web clients.
#[derive(Debug, Clone, Serialize)]
pub struct EventEnvelope {
    pub event: String,
    pub payload: Value,
}

#[derive(Clone)]
pub struct AppCtx {
    inner: Arc<Inner>,
}

struct Inner {
    data_dir: PathBuf,
    resource_dir: Option<PathBuf>,
    /// Headless state registry. In the desktop build this stays empty and
    /// [`AppCtx::state`] delegates to Tauri's managed state so the same
    /// instances are visible from `tauri::State<'_, T>` parameters.
    states: RwLock<HashMap<TypeId, Box<dyn Any + Send + Sync>>>,
    events: broadcast::Sender<EventEnvelope>,
    #[cfg(feature = "desktop")]
    tauri: Option<tauri::AppHandle>,
}

impl AppCtx {
    /// Build a headless context (web server / tests).
    pub fn headless(data_dir: PathBuf, resource_dir: Option<PathBuf>) -> Self {
        let (events, _) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        Self {
            inner: Arc::new(Inner {
                data_dir,
                resource_dir,
                states: RwLock::new(HashMap::new()),
                events,
                #[cfg(feature = "desktop")]
                tauri: None,
            }),
        }
    }

    /// Build a context backed by a Tauri application handle.
    #[cfg(feature = "desktop")]
    pub fn desktop(app: &tauri::AppHandle) -> Self {
        use tauri::Manager;
        let (events, _) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        let data_dir = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| default_data_dir());
        let resource_dir = app.path().resource_dir().ok();
        Self {
            inner: Arc::new(Inner {
                data_dir,
                resource_dir,
                states: RwLock::new(HashMap::new()),
                events,
                tauri: Some(app.clone()),
            }),
        }
    }

    /// Directory holding `app-state.json`, agent sessions, and other
    /// application-wide (not project-scoped) data.
    pub fn app_data_dir(&self) -> PathBuf {
        self.inner.data_dir.clone()
    }

    /// Bundled resources (pdfium, MCP server build) when known.
    pub fn resource_dir(&self) -> Option<PathBuf> {
        self.inner.resource_dir.clone()
    }

    /// Path of the shared settings store (`app-state.json`).
    pub fn app_state_path(&self) -> PathBuf {
        self.inner.data_dir.join("app-state.json")
    }

    /// Register a shared singleton. Call once per type at startup.
    ///
    /// In the desktop build the value is handed to Tauri's state manager
    /// (`app.manage`) so existing `tauri::State<'_, T>` command parameters
    /// keep working; in headless mode it lives in the context itself.
    pub fn manage<T: Send + Sync + 'static>(&self, value: T) {
        #[cfg(feature = "desktop")]
        if let Some(app) = &self.inner.tauri {
            use tauri::Manager;
            app.manage(value);
            return;
        }
        let mut states = self
            .inner
            .states
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        states.insert(TypeId::of::<T>(), Box::new(value));
    }

    /// Fetch a shared singleton registered with [`AppCtx::manage`].
    ///
    /// Panics if the type was never registered — the same contract as
    /// `tauri::AppHandle::state`. The returned guard derefs to `&T` and keeps
    /// the owning registry alive; every state type in this crate is shared
    /// behind interior mutability, so clone what you need out of it.
    pub fn state<T: Send + Sync + 'static>(&self) -> StateRef<T> {
        #[cfg(feature = "desktop")]
        if let Some(app) = &self.inner.tauri {
            use tauri::Manager;
            let state = app.state::<T>();
            // Tauri keeps managed state alive for the lifetime of the app,
            // and the cloned AppHandle stored in the guard keeps the app
            // alive, so the pointer stays valid for as long as the guard.
            let ptr: *const T = state.inner();
            return StateRef {
                ptr,
                _keep_alive: KeepAlive::Desktop(app.clone()),
            };
        }
        let states = self
            .inner
            .states
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let boxed = states.get(&TypeId::of::<T>()).unwrap_or_else(|| {
            panic!(
                "AppCtx::state: {} was not registered with AppCtx::manage",
                std::any::type_name::<T>()
            )
        });
        let value: &T = boxed
            .downcast_ref::<T>()
            .expect("AppCtx::state: TypeId mismatch");
        let ptr: *const T = value;
        StateRef {
            ptr,
            _keep_alive: KeepAlive::Headless(self.inner.clone()),
        }
    }

    /// Emit an event to every attached UI: the Tauri webview (desktop build)
    /// and any web clients subscribed to the SSE stream.
    pub fn emit<S: Serialize>(&self, event: &str, payload: S) -> Result<(), String> {
        let value = serde_json::to_value(&payload).map_err(|e| e.to_string())?;
        // Broadcast to web subscribers first; a send error only means nobody
        // is listening right now, which is not an error for the emitter.
        let _ = self.inner.events.send(EventEnvelope {
            event: event.to_string(),
            payload: value.clone(),
        });
        #[cfg(feature = "desktop")]
        if let Some(app) = &self.inner.tauri {
            use tauri::Emitter;
            return app.emit(event, value).map_err(|e| e.to_string());
        }
        Ok(())
    }

    /// Subscribe to the event stream (used by the web server's SSE route).
    pub fn subscribe(&self) -> broadcast::Receiver<EventEnvelope> {
        self.inner.events.subscribe()
    }

    /// True when running inside the Tauri desktop application.
    pub fn is_desktop(&self) -> bool {
        #[cfg(feature = "desktop")]
        {
            self.inner.tauri.is_some()
        }
        #[cfg(not(feature = "desktop"))]
        {
            false
        }
    }

    /// The underlying Tauri handle, when available.
    #[cfg(feature = "desktop")]
    pub fn tauri(&self) -> Option<&tauri::AppHandle> {
        self.inner.tauri.as_ref()
    }
}

/// Default application data directory for headless mode
/// (`$LLM_WIKI_DATA_DIR`, else `~/.llm-wiki`, else `./llm-wiki-data`).
pub fn default_data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("LLM_WIKI_DATA_DIR") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir);
        }
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    match home {
        Some(home) => home.join(".llm-wiki"),
        None => PathBuf::from("llm-wiki-data"),
    }
}

/// Keeps the owner of a [`StateRef`] pointee alive; never read, only held.
#[allow(dead_code)]
enum KeepAlive {
    #[cfg(feature = "desktop")]
    Desktop(tauri::AppHandle),
    Headless(Arc<Inner>),
}

/// Borrow of a managed state value. Derefs to `&T` for as long as the guard
/// lives; clone whatever you need out of it before crossing an `.await`.
pub struct StateRef<T: 'static> {
    ptr: *const T,
    _keep_alive: KeepAlive,
}

// The pointee is owned either by Tauri's state manager or by the `Inner`
// map, both of which are kept alive by `_keep_alive` and never remove or
// move entries once inserted (managing the same type twice is a programmer
// error that Tauri also rejects).
unsafe impl<T: Send + Sync + 'static> Send for StateRef<T> {}
unsafe impl<T: Send + Sync + 'static> Sync for StateRef<T> {}

impl<T: 'static> std::ops::Deref for StateRef<T> {
    type Target = T;
    fn deref(&self) -> &T {
        // SAFETY: see the comment on the unsafe impls above.
        unsafe { &*self.ptr }
    }
}

impl<T: 'static> StateRef<T> {
    pub fn inner(&self) -> &T {
        self
    }
}

#[cfg(feature = "desktop")]
impl<'de, R: tauri::Runtime> tauri::ipc::CommandArg<'de, R> for AppCtx {
    fn from_command(
        command: tauri::ipc::CommandItem<'de, R>,
    ) -> Result<Self, tauri::ipc::InvokeError> {
        command
            .message
            .state_ref()
            .try_get::<AppCtx>()
            .map(|state| state.inner().clone())
            .ok_or_else(|| {
                tauri::ipc::InvokeError::from("AppCtx is not managed by the Tauri app")
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Counter(std::sync::Mutex<u32>);

    #[test]
    fn headless_state_roundtrip() {
        let ctx = AppCtx::headless(PathBuf::from("/tmp/x"), None);
        ctx.manage(Counter(std::sync::Mutex::new(1)));
        *ctx.state::<Counter>().0.lock().unwrap() += 1;
        assert_eq!(*ctx.state::<Counter>().0.lock().unwrap(), 2);
    }

    #[test]
    fn emit_reaches_subscribers() {
        let ctx = AppCtx::headless(PathBuf::from("/tmp/x"), None);
        let mut rx = ctx.subscribe();
        ctx.emit("hello", serde_json::json!({"a": 1})).unwrap();
        let env = rx.try_recv().unwrap();
        assert_eq!(env.event, "hello");
        assert_eq!(env.payload["a"], 1);
    }
}
