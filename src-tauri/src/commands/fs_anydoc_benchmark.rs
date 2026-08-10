//! Local-only comparison harness for AnyDoc and the compatibility parsers.
//!
//! This module is compiled only for Rust tests and its benchmark is ignored by
//! default. It never changes the production parser selection or writes into a
//! project. Point `ANYDOC_BENCH_DIR` at a fixture corpus or real document tree:
//!
//! ```text
//! ANYDOC_BENCH_DIR=/path/to/documents cargo test --lib \
//!   commands::fs::anydoc_benchmark::compare_anydoc_with_legacy -- \
//!   --ignored --nocapture
//! ```

use super::extract_office_text_compat;
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const BENCH_EXTENSIONS: &[&str] = &[
    "doc", "docx", "docm", "ppt", "pps", "pot", "pptx", "pptm", "ppsx", "ppsm", "xls", "xlsx",
    "xlsm", "xlsb", "odt", "ods", "odp", "rtf",
];

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct StructureStats {
    chars: usize,
    headings: usize,
    list_items: usize,
    table_rows: usize,
    links: usize,
    footnotes: usize,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct FormatSummary {
    files: usize,
    anydoc_ok: usize,
    legacy_supported: usize,
    legacy_ok: usize,
    output_differences: usize,
    anydoc_micros: u128,
    legacy_micros: u128,
    anydoc_structure: StructureStats,
    legacy_structure: StructureStats,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileComparison {
    path: String,
    extension: String,
    anydoc_ok: bool,
    legacy_supported: bool,
    legacy_ok: bool,
    anydoc_micros: u128,
    legacy_micros: Option<u128>,
    anydoc: Option<StructureStats>,
    legacy: Option<StructureStats>,
    output_equal: Option<bool>,
    anydoc_error: Option<String>,
    legacy_error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BenchmarkReport {
    root: String,
    iterations: usize,
    files: Vec<FileComparison>,
    by_format: BTreeMap<String, FormatSummary>,
}

fn legacy_supports(extension: &str) -> bool {
    matches!(
        extension,
        "doc" | "docx" | "pptx" | "xls" | "xlsx" | "odt" | "ods" | "odp"
    )
}

fn collect_documents(root: &Path, output: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("");
            // Invalid/abuse corpora measure error handling rather than output
            // quality and can dominate timing with intentional resource caps.
            if !matches!(name, "abuse" | "malformed") {
                collect_documents(&path, output);
            }
            continue;
        }
        let extension = path
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if BENCH_EXTENSIONS.contains(&extension.as_str()) {
            output.push(path);
        }
    }
}

fn structure_stats(markdown: &str) -> StructureStats {
    let mut stats = StructureStats {
        chars: markdown.chars().count(),
        ..Default::default()
    };
    for line in markdown.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with('#') && trimmed.chars().take_while(|ch| *ch == '#').count() <= 6 {
            stats.headings += 1;
        }
        if trimmed.starts_with("- ")
            || trimmed.starts_with("* ")
            || trimmed
                .split_once(". ")
                .is_some_and(|(prefix, _)| prefix.chars().all(|ch| ch.is_ascii_digit()))
        {
            stats.list_items += 1;
        }
        if trimmed.starts_with('|') && trimmed.ends_with('|') {
            stats.table_rows += 1;
        }
        stats.links += trimmed.matches("](").count();
        stats.footnotes += trimmed.matches("[^").count();
    }
    stats
}

fn add_stats(total: &mut StructureStats, next: &StructureStats) {
    total.chars += next.chars;
    total.headings += next.headings;
    total.list_items += next.list_items;
    total.table_rows += next.table_rows;
    total.links += next.links;
    total.footnotes += next.footnotes;
}

fn timed_best<T>(iterations: usize, mut operation: impl FnMut() -> T) -> (T, Duration) {
    let mut best = Duration::MAX;
    let mut final_value = None;
    for _ in 0..iterations {
        let started = Instant::now();
        let value = operation();
        best = best.min(started.elapsed());
        final_value = Some(value);
    }
    (
        final_value.expect("benchmark iterations are clamped to at least one"),
        best,
    )
}

fn caught_anydoc(path: &Path) -> Result<String, String> {
    std::panic::catch_unwind(|| anydoc::to_markdown(path))
        .map_err(|_| "panic".to_string())?
        .map_err(|error| error.to_string())
}

fn caught_legacy(path: &Path, extension: &str) -> Result<String, String> {
    let path = path.to_string_lossy().into_owned();
    std::panic::catch_unwind(|| extract_office_text_compat(&path, extension))
        .map_err(|_| "panic".to_string())?
}

#[test]
#[ignore = "local benchmark; set ANYDOC_BENCH_DIR to a document corpus"]
fn compare_anydoc_with_legacy() {
    let root = std::env::var("ANYDOC_BENCH_DIR")
        .map(PathBuf::from)
        .expect("ANYDOC_BENCH_DIR must point to a local document corpus");
    assert!(
        root.is_dir(),
        "benchmark directory does not exist: {}",
        root.display()
    );
    let iterations = std::env::var("ANYDOC_BENCH_ITERATIONS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(3)
        .clamp(1, 20);

    let mut paths = Vec::new();
    collect_documents(&root, &mut paths);
    paths.sort();
    assert!(
        !paths.is_empty(),
        "no supported documents found under {}",
        root.display()
    );

    let mut report = BenchmarkReport {
        root: root.display().to_string(),
        iterations,
        files: Vec::with_capacity(paths.len()),
        by_format: BTreeMap::new(),
    };

    for path in paths {
        let extension = path
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let (anydoc_result, anydoc_elapsed) = timed_best(iterations, || caught_anydoc(&path));
        let legacy_supported = legacy_supports(&extension);
        let (legacy_result, legacy_elapsed) = if legacy_supported {
            let (result, elapsed) = timed_best(iterations, || caught_legacy(&path, &extension));
            (Some(result), Some(elapsed))
        } else {
            (None, None)
        };

        let anydoc_stats = anydoc_result
            .as_ref()
            .ok()
            .map(|text| structure_stats(text));
        let legacy_stats = legacy_result
            .as_ref()
            .and_then(|result| result.as_ref().ok())
            .map(|text| structure_stats(text));
        let output_equal = legacy_result
            .as_ref()
            .and_then(|legacy| Some(anydoc_result.as_ref().ok()? == legacy.as_ref().ok()?));

        let summary = report.by_format.entry(extension.clone()).or_default();
        summary.files += 1;
        summary.anydoc_ok += usize::from(anydoc_result.is_ok());
        summary.legacy_supported += usize::from(legacy_supported);
        summary.legacy_ok += usize::from(legacy_result.as_ref().is_some_and(Result::is_ok));
        summary.output_differences += usize::from(output_equal == Some(false));
        summary.anydoc_micros += anydoc_elapsed.as_micros();
        summary.legacy_micros += legacy_elapsed
            .map(|elapsed| elapsed.as_micros())
            .unwrap_or(0);
        if let Some(stats) = &anydoc_stats {
            add_stats(&mut summary.anydoc_structure, stats);
        }
        if let Some(stats) = &legacy_stats {
            add_stats(&mut summary.legacy_structure, stats);
        }

        report.files.push(FileComparison {
            path: path
                .strip_prefix(&root)
                .unwrap_or(&path)
                .display()
                .to_string(),
            extension,
            anydoc_ok: anydoc_result.is_ok(),
            legacy_supported,
            legacy_ok: legacy_result.as_ref().is_some_and(Result::is_ok),
            anydoc_micros: anydoc_elapsed.as_micros(),
            legacy_micros: legacy_elapsed.map(|elapsed| elapsed.as_micros()),
            anydoc: anydoc_stats,
            legacy: legacy_stats,
            output_equal,
            anydoc_error: anydoc_result.err(),
            legacy_error: legacy_result.and_then(Result::err),
        });
    }

    println!("\nAnyDoc comparison benchmark (best of {iterations})");
    println!("format files anydoc legacy anydoc_us legacy_us chars(A/L) structure H/L/T(A/L)");
    for (format, summary) in &report.by_format {
        println!(
            "{format:>5} {:>5} {:>3}/{:<3} {:>3}/{:<3} {:>9} {:>9} {:>8}/{:<8} {:>3}/{:<3} {:>3}/{:<3} {:>3}/{:<3}",
            summary.files,
            summary.anydoc_ok,
            summary.files,
            summary.legacy_ok,
            summary.legacy_supported,
            summary.anydoc_micros,
            summary.legacy_micros,
            summary.anydoc_structure.chars,
            summary.legacy_structure.chars,
            summary.anydoc_structure.headings,
            summary.legacy_structure.headings,
            summary.anydoc_structure.list_items,
            summary.legacy_structure.list_items,
            summary.anydoc_structure.table_rows,
            summary.legacy_structure.table_rows,
        );
    }
    println!(
        "ANYDOC_BENCHMARK_JSON={}",
        serde_json::to_string(&report).expect("benchmark report must serialize")
    );
}
