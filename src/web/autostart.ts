// Web shim for `@tauri-apps/plugin-autostart` (no-op in the browser).
export async function enable(): Promise<void> { return }
export async function disable(): Promise<void> { return }
export async function isEnabled(): Promise<boolean> { return false }
