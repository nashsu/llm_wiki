# macOS installation, operation, upgrade, and rollback

## Install and start

Download the `.dmg` for your architecture from the matching GitHub Release, verify the published SHA-256 checksum, open it, and drag **LLM Wiki** to `/Applications`. Launch it from Finder. macOS may require confirmation in **System Settings → Privacy & Security** on first launch.

Developer builds can be started from a clean checkout with `npm ci`, `npm --prefix mcp-server ci`, then `npm run tauri dev`. The local API binds to `127.0.0.1` by default; do not enable LAN access without applying the product's authentication guidance.

Keep vaults outside the source checkout. Back up the entire vault—including hidden `.obsidian` and `.llm-wiki` directories—before an upgrade. API keys and signing credentials must never be placed in the repository or vault.

## Upgrade

1. Quit LLM Wiki and Obsidian.
2. Make a timestamped copy or filesystem snapshot of the vault and application data.
3. Read release notes for migrations and minimum macOS requirements.
4. Verify the new download checksum, replace the app in `/Applications`, and start it.
5. Open a non-critical vault first; confirm notes, attachments, settings, search index, local API binding, and provider configuration before normal use.

Do not delete the previous installer until the new version has passed the smoke test. Index data is derived and may be rebuilt, but the vault is authoritative user data.

## Roll back

1. Quit both applications and preserve the failed post-upgrade state for diagnosis.
2. Restore the pre-upgrade vault/application-data snapshot if the release performed a data migration.
3. Replace `/Applications/LLM Wiki.app` with the prior verified release.
4. Start offline where practical, confirm the vault, then rebuild derived indexes if required.

If rollback still fails, keep the vault untouched, collect redacted application logs, and report the old/new versions, macOS version, architecture, and exact failing step. Never attach API keys, tokens, vault content, or `app-state.json` to an issue.
