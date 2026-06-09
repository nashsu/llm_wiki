//! Dedicated Tokio runtime for the local HTTP API server.
//!
//! Isolates `block_on` search/embedding work from Tauri's shared async runtime
//! so bursty API traffic cannot starve UI-facing commands.

use std::sync::OnceLock;

static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();

pub fn block_on<F: std::future::Future>(future: F) -> F::Output {
    let runtime = RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .thread_name("llm-wiki-api")
            .build()
            .expect("failed to build API runtime")
    });
    runtime.block_on(future)
}
