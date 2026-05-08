#!/usr/bin/env bash
set -euo pipefail

APP_NAME="LLM Wiki.app"
DEST_APP="/Applications/${APP_NAME}"
SOURCE_APP="${SOURCE_APP:-$(pwd)/src-tauri/target/release/bundle/macos/${APP_NAME}}"
BACKUP_ROOT="${BACKUP_ROOT:-/private/tmp/llmwiki-install-backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="${BACKUP_ROOT}/${STAMP}"
CACHE_DIR="${HOME}/Library/Caches/com.llmwiki.app"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

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

if [[ -d "${DEST_APP}" ]]; then
  mv "${DEST_APP}" "${BACKUP_DIR}/${APP_NAME}"
fi

if [[ -d "${CACHE_DIR}" ]]; then
  mv "${CACHE_DIR}" "${BACKUP_DIR}/com.llmwiki.app.cache"
fi

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

echo "Installed ${DEST_APP}"
echo "Verified sidebar logo reference: ${installed_logo_ref}"
echo "Backup: ${BACKUP_DIR}"
