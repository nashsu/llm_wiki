/**
 * Vitest setup file — loads `.env.test.local` into process.env before
 * any test module imports. Registered via `test.setupFiles` in
 * vite.config.ts.
 *
 * Why a hand-rolled dotenv loader instead of the `dotenv` package:
 *   We intentionally avoid adding a prod dependency just for tests.
 *   The file format we support is a tiny subset — KEY=value lines,
 *   `#` comments, optional surrounding quotes. If the project ever
 *   outgrows this, swap in the real `dotenv` package.
 *
 * Precedence: variables already present in process.env (e.g. set by
 * the npm script or the shell) are NOT overwritten, so CI can still
 * override endpoints for special runs.
 */
import fs from "node:fs"
import path from "node:path"

const envPath = path.resolve(process.cwd(), ".env.test.local")
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, "utf-8")
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith("#")) continue
    const eqIdx = line.indexOf("=")
    if (eqIdx < 0) continue
    const key = line.slice(0, eqIdx).trim()
    const rawValue = line.slice(eqIdx + 1).trim()
    // Strip ONE layer of matching surrounding quotes (single or double).
    const value =
      (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && rawValue.endsWith("'"))
        ? rawValue.slice(1, -1)
        : rawValue
    if (!(key in process.env)) process.env[key] = value
  }
}
