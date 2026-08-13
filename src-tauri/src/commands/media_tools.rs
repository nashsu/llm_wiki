//! Downloads and caches ffmpeg + yt-dlp when missing from PATH, so the
//! media-ingest feature (audio/video transcription) works without asking
//! the user to install anything manually. Mirrors `node_runtime.rs`'s
//! cache -> PATH -> download resolution order.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Emitter, Manager};

use super::cli_resolver::find_cli_command;

fn install_root(app: &AppHandle, subdir: &str) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not resolve app data directory: {e}"))?;
    Ok(base.join(subdir))
}

fn ytdlp_asset_name() -> Result<(&'static str, &'static str), String> {
    // (release asset name, local binary file name)
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Ok(("yt-dlp_linux", "yt-dlp")),
        ("linux", "aarch64") => Ok(("yt-dlp_linux_aarch64", "yt-dlp")),
        ("macos", _) => Ok(("yt-dlp_macos", "yt-dlp")),
        ("windows", "x86_64") => Ok(("yt-dlp.exe", "yt-dlp.exe")),
        (os, arch) => Err(format!(
            "No automatic yt-dlp download available for {os}/{arch} — install yt-dlp manually and reopen Settings."
        )),
    }
}

/// Cache -> PATH -> download. Returns the absolute path to a working
/// `yt-dlp` binary. Downloads via GitHub's `releases/latest/download`
/// redirect: no `api.github.com` call, so the unauthenticated 60/hour rate
/// limit cannot turn a working download into a spurious failure.
pub async fn ensure_ytdlp(app: &AppHandle) -> Result<PathBuf, String> {
    let root = install_root(app, "ytdlp-runtime")?;
    let (_, local_name) = ytdlp_asset_name()?;
    let cached = root.join(local_name);
    if cached.is_file() {
        return Ok(cached);
    }
    if let Ok(path) = find_cli_command("yt-dlp", &["yt-dlp.exe"]).await {
        return Ok(path);
    }

    let (asset_name, local_name) = ytdlp_asset_name()?;
    let url = format!("https://github.com/yt-dlp/yt-dlp/releases/latest/download/{asset_name}");
    let _ = app.emit("media-tools:log", "Downloading yt-dlp…".to_string());

    std::fs::create_dir_all(&root).map_err(|e| format!("Failed to create {}: {e}", root.display()))?;
    let response = reqwest::get(&url)
        .await
        .map_err(|e| format!("Failed to download yt-dlp from {url}: {e}"))?;
    // Without this, a 404/503 HTML body would be chmod 0755'd and cached as
    // the yt-dlp binary forever (the `cached.is_file()` short-circuit above
    // never re-downloads).
    if !response.status().is_success() {
        return Err(format!(
            "Failed to download yt-dlp: HTTP {} from {url}",
            response.status()
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read yt-dlp download body: {e}"))?;

    let dest = root.join(local_name);
    std::fs::write(&dest, &bytes).map_err(|e| format!("Failed to write {}: {e}", dest.display()))?;
    make_executable(&dest)?;

    let _ = app.emit("media-tools:log", "yt-dlp ready.".to_string());
    Ok(dest)
}

fn make_executable(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(path)
            .map_err(|e| format!("Failed to read metadata for {}: {e}", path.display()))?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(path, perms)
            .map_err(|e| format!("Failed to chmod {}: {e}", path.display()))?;
    }
    Ok(())
}

/// Mirrors `AUDIO_VIDEO_SOURCE_EXTENSIONS` in `src/lib/media-extensions.ts`.
const DIRECT_MEDIA_URL_EXTENSIONS: &[&str] = &[
    "mp4", "webm", "mov", "avi", "mkv", "mp3", "wav", "ogg", "flac", "m4a",
];

/// True when the URL *is* a media file rather than a page that may embed one.
///
/// ponytail: extension sniffing, not a HEAD request. An extension-less direct
/// media URL (`https://cdn.example/stream?id=1`) loses generic-extractor
/// support; probe the Content-Type here if that turns out to matter.
fn is_direct_media_file_url(url: &str) -> bool {
    let path = url.split(['?', '#']).next().unwrap_or(url);
    path.rsplit('/')
        .next()
        .and_then(|file| file.rsplit_once('.'))
        .is_some_and(|(_, ext)| DIRECT_MEDIA_URL_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
}

/// yt-dlp prints one `after_move:filepath` line per file it downloaded.
/// Exactly one line = the single media link we asked for. More than one
/// means the generic extractor scraped several embeds off an ordinary web
/// page (exit code 0, no error) — that is not a media URL, so it gets the
/// same `unsupported URL` prefix callers already match on.
fn single_media_path<'a>(stdout: &'a str, url: &str) -> Result<&'a str, String> {
    let mut paths = stdout.lines().map(str::trim).filter(|line| !line.is_empty());
    let first = paths.next().unwrap_or("");
    if paths.next().is_some() {
        return Err(format!(
            "unsupported URL: {url} yielded several embedded media files, not a single media link"
        ));
    }
    Ok(first)
}

/// Downloads only the audio track of `url` via yt-dlp into the OS temp
/// directory. Returns the local file path on success. On failure, the
/// error message is prefixed with "unsupported URL" when yt-dlp itself
/// reports it doesn't recognize the site/URL (as opposed to a network
/// error, geo-block, or private video), and also when the URL turns out to
/// be an ordinary page yt-dlp scraped several embeds from — callers use
/// that prefix to decide whether to fall back to a different import path.
#[tauri::command]
pub async fn download_media_url(app: AppHandle, url: String) -> Result<String, String> {
    let ytdlp = ensure_ytdlp(&app).await?;

    let temp_dir = std::env::temp_dir().join("llm-wiki-media-import");
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create {}: {e}", temp_dir.display()))?;
    let output_template = temp_dir.join("%(title).100B [%(id)s].%(ext)s");

    let ffmpeg = ensure_ffmpeg(&app).await?;
    let ffmpeg_dir = ffmpeg
        .parent()
        .ok_or_else(|| "Could not determine ffmpeg's parent directory".to_string())?;

    let mut command = tokio::process::Command::new(&ytdlp);
    command
        .arg("--no-playlist")
        .arg("-x")
        .arg("--audio-format")
        .arg("mp3")
        .arg("--ffmpeg-location")
        .arg(ffmpeg_dir)
        .arg("-o")
        .arg(&output_template)
        .arg("--print")
        .arg("after_move:filepath");
    if !is_direct_media_file_url(&url) {
        // The generic extractor scrapes embeds off ordinary web pages, so an
        // article with a single embedded clip would import as that clip's
        // audio instead of the article text. Disabling it leaves only real,
        // site-specific extractors (YouTube, Vimeo, …); everything else errors
        // out and the caller falls back to the text-fetch path. Direct media
        // file URLs are exempt — generic is the correct handler for those.
        command.arg("--use-extractors").arg("default,-generic");
    }
    let output = command
        .arg(&url)
        .output()
        .await
        .map_err(|e| format!("Failed to spawn yt-dlp: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let lower = stderr.to_lowercase();
        // `--use-extractors default,-generic` reports a non-media page as
        // "No suitable extractor found for URL", not "Unsupported URL".
        if lower.contains("unsupported url")
            || lower.contains("is not a valid url")
            || lower.contains("no suitable extractor")
        {
            return Err(format!("unsupported URL: {}", stderr.trim()));
        }
        return Err(format!("yt-dlp failed for {url}: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let path = single_media_path(&stdout, &url)?;
    if path.is_empty() || !Path::new(path).is_file() {
        return Err(format!("yt-dlp reported success but produced no file for {url}"));
    }
    Ok(path.to_string())
}

fn ffmpeg_platform_target() -> Result<&'static str, String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Ok("linux-x64"),
        ("linux", "aarch64") => Ok("linux-arm64"),
        ("macos", "x86_64") => Ok("darwin-x64"),
        ("macos", "aarch64") => Ok("darwin-arm64"),
        ("windows", "x86_64") => Ok("win32-x64"),
        (os, arch) => Err(format!(
            "No automatic ffmpeg download available for {os}/{arch} — install ffmpeg manually and reopen Settings."
        )),
    }
}

fn ffmpeg_binary_name() -> &'static str {
    if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" }
}

/// Cache -> PATH -> download. Returns the absolute path to a working
/// `ffmpeg` binary. `eugeneware/ffmpeg-static` publishes one gzip'd static
/// binary per platform — decompress with `flate2` (already a dependency),
/// no tar/zip/xz needed.
pub async fn ensure_ffmpeg(app: &AppHandle) -> Result<PathBuf, String> {
    let root = install_root(app, "ffmpeg-runtime")?;
    let cached = root.join(ffmpeg_binary_name());
    if cached.is_file() {
        return Ok(cached);
    }
    if let Ok(path) = find_cli_command("ffmpeg", &["ffmpeg.exe"]).await {
        return Ok(path);
    }

    let platform = ffmpeg_platform_target()?;
    let asset = format!("ffmpeg-{platform}.gz");
    let url = format!("https://github.com/eugeneware/ffmpeg-static/releases/latest/download/{asset}");
    let _ = app.emit("media-tools:log", "Downloading ffmpeg…".to_string());

    std::fs::create_dir_all(&root).map_err(|e| format!("Failed to create {}: {e}", root.display()))?;
    let response = reqwest::get(&url)
        .await
        .map_err(|e| format!("Failed to download ffmpeg from {url}: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Failed to download ffmpeg: HTTP {} from {url}",
            response.status()
        ));
    }
    let compressed = response
        .bytes()
        .await
        .map_err(|e| format!("Failed to read ffmpeg download body: {e}"))?;

    let mut decoder = flate2::read::GzDecoder::new(std::io::Cursor::new(compressed));
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut decoder, &mut bytes)
        .map_err(|e| format!("Failed to decompress ffmpeg archive: {e}"))?;

    let dest = root.join(ffmpeg_binary_name());
    std::fs::write(&dest, &bytes).map_err(|e| format!("Failed to write {}: {e}", dest.display()))?;
    make_executable(&dest)?;

    let _ = app.emit("media-tools:log", "ffmpeg ready.".to_string());
    Ok(dest)
}

/// Extracts a mono, 16kHz, low-bitrate MP3 audio track from any file
/// ffmpeg can demux (works for pure-audio inputs too, not just video).
/// Low bitrate keeps the extracted file well under Groq's 25MB upload
/// limit for the vast majority of sources; Task 6 (TS side) still splits
/// further for anything unusually long.
#[tauri::command]
pub async fn extract_audio_track(app: AppHandle, source_path: String) -> Result<String, String> {
    let ffmpeg = ensure_ffmpeg(&app).await?;

    let temp_dir = std::env::temp_dir().join("llm-wiki-media-import");
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| format!("Failed to create {}: {e}", temp_dir.display()))?;
    let stem = Path::new(&source_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("audio");
    let dest = temp_dir.join(format!("{stem}-{}.mp3", uuid::Uuid::new_v4()));

    let output = tokio::process::Command::new(&ffmpeg)
        .arg("-y")
        .arg("-i")
        .arg(&source_path)
        .arg("-vn")
        .arg("-ac")
        .arg("1")
        .arg("-ar")
        .arg("16000")
        .arg("-b:a")
        .arg("32k")
        .arg(&dest)
        .output()
        .await
        .map_err(|e| format!("Failed to spawn ffmpeg: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffmpeg failed to extract audio from {source_path}: {}", stderr.trim()));
    }
    if !dest.is_file() {
        return Err(format!("ffmpeg reported success but produced no output for {source_path}"));
    }
    Ok(dest.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::{is_direct_media_file_url, single_media_path};

    #[test]
    fn direct_media_files_keep_the_generic_extractor() {
        assert!(is_direct_media_file_url("https://example.com/talk.MP3"));
        assert!(is_direct_media_file_url("https://example.com/a/b/clip.mp4?token=1"));
    }

    #[test]
    fn ordinary_pages_do_not() {
        assert!(!is_direct_media_file_url("https://en.wikipedia.org/wiki/Apollo_11"));
        assert!(!is_direct_media_file_url("https://example.com/posts/mp3-review"));
        assert!(!is_direct_media_file_url("https://example.com/"));
    }

    #[test]
    fn single_line_is_the_media_path() {
        assert_eq!(single_media_path("/tmp/a.mp3\n", "u").unwrap(), "/tmp/a.mp3");
    }

    #[test]
    fn several_lines_are_reported_as_unsupported() {
        let err = single_media_path("/tmp/a.webm\n/tmp/b.webm\n", "u").unwrap_err();
        assert!(err.to_lowercase().starts_with("unsupported url"), "{err}");
    }

    #[test]
    fn no_lines_stays_empty_for_the_no_file_check() {
        assert_eq!(single_media_path("\n", "u").unwrap(), "");
    }
}
