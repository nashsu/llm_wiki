// Shared between source-lifecycle.ts (ingest gate) and source-watch-config.ts
// (auto-watch default extensions) — kept in its own file because those two
// modules already import from each other and a two-way dependency would be
// circular.
export const AUDIO_VIDEO_SOURCE_EXTENSIONS = new Set([
  "mp4", "webm", "mov", "avi", "mkv", "mp3", "wav", "ogg", "flac", "m4a",
])

export const IMAGE_SOURCE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff", "avif", "heic",
])
