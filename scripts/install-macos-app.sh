#!/usr/bin/env bash
set -euo pipefail

APP_NAME="LLM Wiki.app"
DEST_APP="${DEST_APP:-/Applications/${APP_NAME}}"
SOURCE_APP="${SOURCE_APP:-$(pwd)/src-tauri/target/release/bundle/macos/${APP_NAME}}"
BACKUP_ROOT="${BACKUP_ROOT:-/private/tmp/llmwiki-install-backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="${BACKUP_ROOT}/${STAMP}"
BUNDLE_ID="${BUNDLE_ID:-com.llmwiki.desktop}"
LEGACY_BUNDLE_ID="${LEGACY_BUNDLE_ID:-com.llmwiki.app}"
CACHE_DIR="${HOME}/Library/Caches/${BUNDLE_ID}"
LEGACY_CACHE_DIR="${HOME}/Library/Caches/${LEGACY_BUNDLE_ID}"
WEBKIT_DIR="${HOME}/Library/WebKit/${BUNDLE_ID}"
LEGACY_WEBKIT_DIR="${HOME}/Library/WebKit/${LEGACY_BUNDLE_ID}"
SAVED_STATE_DIR="${HOME}/Library/Saved Application State/${BUNDLE_ID}.savedState"
LEGACY_SAVED_STATE_DIR="${HOME}/Library/Saved Application State/${LEGACY_BUNDLE_ID}.savedState"
APP_SUPPORT_DIR="${HOME}/Library/Application Support/${BUNDLE_ID}"
LEGACY_APP_SUPPORT_DIR="${HOME}/Library/Application Support/${LEGACY_BUNDLE_ID}"
LSREGISTER="${LSREGISTER:-/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister}"

backup_move_dir() {
  local dir="$1"
  local label="$2"
  if [[ -d "${dir}" ]]; then
    mv "${dir}" "${BACKUP_DIR}/${label}"
  fi
}

backup_copy_dir() {
  local dir="$1"
  local label="$2"
  if [[ -d "${dir}" ]]; then
    ditto "${dir}" "${BACKUP_DIR}/${label}"
  fi
}

if [[ ! -d "${SOURCE_APP}" ]]; then
  echo "Missing built app bundle: ${SOURCE_APP}" >&2
  echo "Run: npm run tauri -- build --bundles app" >&2
  exit 1
fi

source_logo_ref="$(strings "${SOURCE_APP}/Contents/MacOS/llm-wiki" | grep -Eo '/assets/logo-[A-Za-z0-9_-]+\.jpg' | head -n 1 || true)"
if [[ -z "${source_logo_ref}" ]]; then
  echo "Built app does not contain a bundled sidebar logo reference." >&2
  exit 1
fi

mkdir -p "${BACKUP_DIR}"

osascript -e 'tell application "LLM Wiki" to quit' >/dev/null 2>&1 || true
for _ in {1..20}; do
  if ! pgrep -x "llm-wiki" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
if pgrep -x "llm-wiki" >/dev/null 2>&1; then
  pkill -x "llm-wiki" >/dev/null 2>&1 || true
fi

if [[ -d "${DEST_APP}" ]]; then
  chflags -R nouchg "${DEST_APP}" 2>/dev/null || true
  mv "${DEST_APP}" "${BACKUP_DIR}/${APP_NAME}"
fi

backup_copy_dir "${LEGACY_APP_SUPPORT_DIR}" "${LEGACY_BUNDLE_ID}.app-support"
backup_copy_dir "${APP_SUPPORT_DIR}" "${BUNDLE_ID}.app-support"
if [[ -d "${LEGACY_APP_SUPPORT_DIR}" && ! -d "${APP_SUPPORT_DIR}" ]]; then
  mkdir -p "$(dirname "${APP_SUPPORT_DIR}")"
  ditto "${LEGACY_APP_SUPPORT_DIR}" "${APP_SUPPORT_DIR}"
  echo "Migrated app support: ${LEGACY_BUNDLE_ID} -> ${BUNDLE_ID}"
fi
backup_move_dir "${CACHE_DIR}" "${BUNDLE_ID}.cache"
backup_move_dir "${LEGACY_CACHE_DIR}" "${LEGACY_BUNDLE_ID}.cache"
backup_move_dir "${WEBKIT_DIR}" "${BUNDLE_ID}.webkit"
backup_move_dir "${LEGACY_WEBKIT_DIR}" "${LEGACY_BUNDLE_ID}.webkit"
backup_move_dir "${SAVED_STATE_DIR}" "${BUNDLE_ID}.savedState"
backup_move_dir "${LEGACY_SAVED_STATE_DIR}" "${LEGACY_BUNDLE_ID}.savedState"

ditto "${SOURCE_APP}" "${DEST_APP}"
codesign --force --deep --sign - "${DEST_APP}" >/dev/null
touch "${DEST_APP}"
"${LSREGISTER}" -f "${DEST_APP}" >/dev/null

installed_logo_ref="$(strings "${DEST_APP}/Contents/MacOS/llm-wiki" | grep -Eo '/assets/logo-[A-Za-z0-9_-]+\.jpg' | head -n 1 || true)"
if [[ "${installed_logo_ref}" != "${source_logo_ref}" ]]; then
  echo "Installed app logo reference mismatch." >&2
  echo "source:    ${source_logo_ref}" >&2
  echo "installed: ${installed_logo_ref}" >&2
  exit 1
fi

codesign -vvv --deep --strict "${DEST_APP}" >/dev/null
chflags -R uchg "${DEST_APP}"

echo "Installed ${DEST_APP}"
echo "Verified sidebar logo reference: ${installed_logo_ref}"
echo "Locked installed app bundle with uchg."
echo "Backup: ${BACKUP_DIR}"
