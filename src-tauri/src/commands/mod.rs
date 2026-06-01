pub mod agent;
pub mod claude_cli;
pub mod codex_cli;
pub mod file_ops;
pub mod project;
pub mod search;

// Backward-compatible re-exports for lib.rs / api_server.rs paths
pub use file_ops::{extract_images, file_sync, fs};
pub use search::vectorstore;
