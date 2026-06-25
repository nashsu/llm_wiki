//! Panic-to-error boundary for Tauri commands.
//!
//! Third-party parsers (pdf-extract / lopdf, docx-rs, calamine, …) are
//! known to panic on malformed input instead of returning Err. Under
//! `panic = "abort"` that kills the whole app; even with `panic =
//! "unwind"`, letting a panic propagate through the `extern "C"` Tauri
//! command boundary is UB. These helpers catch panics at the command
//! boundary and convert them into a Tauri Err the frontend can display.

use std::any::Any;
use std::panic::{catch_unwind, AssertUnwindSafe};

/// Run a synchronous command body, converting any panic into an Err.
pub fn run_guarded<T, F>(label: &str, f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String>,
{
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(r) => r,
        Err(payload) => Err(report(label, payload)),
    }
}

/// Run an async command body, converting any panic into an Err.
pub async fn run_guarded_async<T, Fut>(label: &str, fut: Fut) -> Result<T, String>
where
    Fut: std::future::Future<Output = Result<T, String>>,
{
    use futures::FutureExt;
    match AssertUnwindSafe(fut).catch_unwind().await {
        Ok(r) => r,
        Err(payload) => Err(report(label, payload)),
    }
}

fn report(label: &str, payload: Box<dyn Any + Send>) -> String {
    let msg = if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else {
        "(non-string panic payload)".to_string()
    };
    eprintln!("[panic_guard] command '{label}' panicked: {msg}");
    format!("Internal error in {label}: {msg}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_catches_string_panic() {
        let result: Result<(), String> = run_guarded("test", || panic!("boom from String"));
        let err = result.expect_err("panic should produce Err");
        assert!(err.contains("boom from String"), "got: {err}");
        assert!(err.starts_with("Internal error in test"), "got: {err}");
    }

    #[test]
    fn sync_catches_panic_with_non_string_payload() {
        let result: Result<(), String> = run_guarded("test", || std::panic::panic_any(42_u32));
        let err = result.expect_err("panic should produce Err");
        assert!(err.contains("non-string panic payload"), "got: {err}");
    }

    #[test]
    fn sync_passes_through_err() {
        let result: Result<i32, String> = run_guarded("test", || Err("regular error".to_string()));
        assert_eq!(result.unwrap_err(), "regular error");
    }

    #[test]
    fn sync_passes_through_ok() {
        let result = run_guarded("test", || Ok::<_, String>(7));
        assert_eq!(result.unwrap(), 7);
    }

    #[tokio::test]
    async fn async_catches_panic() {
        let result: Result<(), String> = run_guarded_async("test", async {
            panic!("async boom");
        })
        .await;
        let err = result.expect_err("panic should produce Err");
        assert!(err.contains("async boom"), "got: {err}");
    }

    #[tokio::test]
    async fn async_catches_panic_after_await_point() {
        let result: Result<(), String> = run_guarded_async("test", async {
            tokio::task::yield_now().await;
            panic!("post-await boom");
        })
        .await;
        let err = result.expect_err("panic should produce Err");
        assert!(err.contains("post-await boom"), "got: {err}");
    }
}
