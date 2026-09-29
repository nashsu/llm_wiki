#!/usr/bin/env bash
set -euo pipefail

target_root="${1:-src-tauri/target}"

app_path="$(find "$target_root" -path '*/release/bundle/macos/*.app' -type d -print -quit)"
dmg_path="$(find "$target_root" -path '*/release/bundle/dmg/*.dmg' -type f -print -quit)"

if [[ -z "$app_path" || -z "$dmg_path" ]]; then
  echo "Expected both a macOS .app bundle and .dmg under $target_root" >&2
  exit 1
fi

verify_app() {
  local app="$1"
  echo "Verifying strict code signature: $app"
  codesign --verify --deep --strict --verbose=2 "$app"
  codesign --display --verbose=4 "$app"
  spctl --assess --type execute --verbose=4 "$app"
  xcrun stapler validate "$app"
}

verify_app "$app_path"

# Tauri notarizes and staples the app bundle before packaging it into the DMG.
# The DMG is a transport container and does not necessarily carry its own
# stapled ticket, so validate the container itself and then verify the mounted
# app bundle below.
echo "Verifying DMG container integrity: $dmg_path"
hdiutil verify "$dmg_path"

mount_point="$(mktemp -d "${TMPDIR:-/tmp}/llm-wiki-dmg.XXXXXX")"
mounted=0
cleanup() {
  if [[ "$mounted" -eq 1 ]]; then
    hdiutil detach "$mount_point" -quiet || hdiutil detach "$mount_point" -force -quiet || true
  fi
  rmdir "$mount_point" 2>/dev/null || true
}
trap cleanup EXIT

hdiutil attach "$dmg_path" -nobrowse -readonly -mountpoint "$mount_point" -quiet
mounted=1
mounted_app="$(find "$mount_point" -maxdepth 2 -name '*.app' -type d -print -quit)"
if [[ -z "$mounted_app" ]]; then
  echo "Mounted DMG does not contain an app bundle" >&2
  exit 1
fi

verify_app "$mounted_app"
