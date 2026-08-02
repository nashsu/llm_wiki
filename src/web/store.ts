// Web shim for `@tauri-apps/plugin-store`.
//
// Shared-data model: the server persists each named store as a JSON file and,
// on the same host as the desktop app, that file IS the desktop's plugin-store
// (see server/src/store.js). So a setting or recent-project written by the
// desktop is readable by the web client and vice versa.
//
// To keep that sharing correct under two writers, this shim performs
// KEY-LEVEL reads and writes against the server (never a whole-object
// snapshot write), so the web client cannot clobber an unrelated key the
// desktop changed. Reads always go to the server (which mtime-caches the
// file), so desktop edits are visible to the web without a restart. Concurrent
// in-flight reads of the same store are coalesced.

import { storeGet, storePut, storePutKey, storeDeleteKey } from "./http-api"

interface LoadOptions {
  autoSave?: boolean
  defaults?: Record<string, unknown>
}

const inflight = new Map<string, Promise<Record<string, unknown>>>()

function fetchObj(name: string): Promise<Record<string, unknown>> {
  const pending = inflight.get(name)
  if (pending) return pending
  const p = storeGet(name)
    .then((v) => (v && typeof v === "object" ? v : {}))
    .catch(() => ({} as Record<string, unknown>))
    .finally(() => inflight.delete(name))
  inflight.set(name, p)
  return p
}

export class Store {
  private readonly name: string
  private readonly defaults: Record<string, unknown>

  constructor(name: string, options: LoadOptions = {}) {
    this.name = name
    this.defaults = options.defaults ?? {}
  }

  async get<T>(key: string): Promise<T | undefined> {
    const obj = await fetchObj(this.name)
    if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key] as T
    if (Object.prototype.hasOwnProperty.call(this.defaults, key)) return this.defaults[key] as T
    return undefined
  }

  async set(key: string, value: unknown): Promise<void> {
    // Key-level read-modify-write on the server: preserves every other key
    // (including ones the desktop wrote since this client booted).
    await storePutKey(this.name, key, value)
  }

  async has(key: string): Promise<boolean> {
    const obj = await fetchObj(this.name)
    return Object.prototype.hasOwnProperty.call(obj, key)
  }

  async delete(key: string): Promise<boolean> {
    const obj = await fetchObj(this.name)
    const existed = Object.prototype.hasOwnProperty.call(obj, key)
    await storeDeleteKey(this.name, key)
    return existed
  }

  async keys(): Promise<string[]> {
    return Object.keys(await fetchObj(this.name))
  }

  async reset(): Promise<void> {
    const obj = await fetchObj(this.name)
    await Promise.all(Object.keys(obj).map((k) => storeDeleteKey(this.name, k)))
  }

  // Writes are persisted on every set(); save() is a compatibility no-op.
  async save(): Promise<void> { return }

  // Compatibility: some callers used the old load()-then-batch pattern.
  async entries(): Promise<Record<string, unknown>> { return fetchObj(this.name) }
}

export async function load(name: string, options: LoadOptions = {}): Promise<Store> {
  return new Store(name, options)
}

// Kept for any code path that still imports the legacy full-object helpers.
export { storeGet as _legacyGet, storePut as _legacyPut }
