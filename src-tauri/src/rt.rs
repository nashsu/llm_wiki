//! Async runtime shim.
//!
//! The desktop build runs on Tauri's tokio runtime (`tauri::async_runtime`);
//! the headless server owns a tokio runtime of its own. Command code should
//! call these helpers instead of either directly so it compiles — and behaves
//! the same — in both builds.

use std::future::Future;
#[cfg(not(feature = "desktop"))]
use std::sync::OnceLock;

#[cfg(not(feature = "desktop"))]
static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();

/// Handle to the process-wide runtime.
#[cfg(not(feature = "desktop"))]
fn runtime() -> &'static tokio::runtime::Runtime {
    RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_name("llm-wiki-rt")
            .build()
            .expect("failed to build tokio runtime")
    })
}

/// Install an externally created runtime (the headless server main does this
/// so the same runtime that drives axum also drives spawned command work).
#[cfg(not(feature = "desktop"))]
pub fn install_runtime(rt: tokio::runtime::Runtime) {
    let _ = RUNTIME.set(rt);
}

/// Spawn a future onto the runtime.
pub fn spawn<F>(future: F) -> tokio::task::JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    #[cfg(feature = "desktop")]
    {
        tauri::async_runtime::handle().inner().spawn(future)
    }
    #[cfg(not(feature = "desktop"))]
    {
        runtime().spawn(future)
    }
}

/// Run a blocking closure on the runtime's blocking pool.
pub fn spawn_blocking<F, R>(func: F) -> tokio::task::JoinHandle<R>
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    #[cfg(feature = "desktop")]
    {
        tauri::async_runtime::handle().inner().spawn_blocking(func)
    }
    #[cfg(not(feature = "desktop"))]
    {
        runtime().spawn_blocking(func)
    }
}

/// Block the current (non-runtime) thread until the future completes.
///
/// Only call this from plain OS threads (the tiny_http request threads);
/// calling it from inside a tokio worker deadlocks, exactly as with
/// `tauri::async_runtime::block_on`.
pub fn block_on<F: Future>(future: F) -> F::Output {
    #[cfg(feature = "desktop")]
    {
        tauri::async_runtime::block_on(future)
    }
    #[cfg(not(feature = "desktop"))]
    {
        runtime().block_on(future)
    }
}
