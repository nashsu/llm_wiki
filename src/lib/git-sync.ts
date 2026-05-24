/**
 * Git collaboration bridge — TypeScript wrappers for the Rust git commands.
 *
 * All commands go through Tauri's `invoke()` IPC.  The `autoCommitOnIngest`
 * helper is designed to be called after a successful ingest so the project
 * automatically tracks changes in git.
 */

import { invoke } from "@tauri-apps/api/core"

// ── Types ─────────────────────────────────────────────────────────────

/** Mirror of `commands::git::GitStatus` (Rust side). */
export interface GitStatus {
  modified: number
  untracked: number
  staged: number
  branch: string
  hasRemote: boolean
}

/** Mirror of `commands::git::CommitEntry` (Rust side). */
export interface CommitEntry {
  hash: string
  message: string
  author: string
  date: string
}

// ── Command wrappers ──────────────────────────────────────────────────

/** Initialize a git repository at the given path. Idempotent. */
export async function gitInit(path: string): Promise<string> {
  return invoke<string>("git_init", { path })
}

/** Get the working-tree status of the repository. */
export async function gitStatus(path: string): Promise<GitStatus> {
  return invoke<GitStatus>("git_status", { path })
}

/** Stage all changes and commit with the given message. */
export async function gitCommit(path: string, message: string): Promise<string> {
  return invoke<string>("git_commit", { path, message })
}

/** Push current branch to origin. */
export async function gitPush(path: string): Promise<string> {
  return invoke<string>("git_push", { path })
}

/** Pull and rebase from origin. */
export async function gitPull(path: string): Promise<string> {
  return invoke<string>("git_pull", { path })
}

/** Get recent commits. */
export async function gitLog(path: string, count: number = 20): Promise<CommitEntry[]> {
  return invoke<CommitEntry[]>("git_log", { path, count })
}

/** Set (or update) the origin remote URL. */
export async function gitSetRemote(path: string, url: string): Promise<void> {
  return invoke<void>("git_set_remote", { path, url })
}

// ── Auto-commit helper ────────────────────────────────────────────────

/**
 * Auto-commit after an ingest operation.
 *
 * Checks git status first — if the repo is not initialized or there are
 * no changes, this is a no-op.  Otherwise stages everything and commits
 * with a descriptive message like "Auto-commit: ingested paper.pdf".
 */
export async function autoCommitOnIngest(
  projectPath: string,
  filename: string,
): Promise<void> {
  try {
    // Ensure git is initialized
    const status = await gitStatus(projectPath)
    if (!status.branch) {
      // Not a git repo — silently skip
      return
    }

    // Check if there is anything to commit
    if (status.modified === 0 && status.untracked === 0 && status.staged === 0) {
      return
    }

    const message = `Auto-commit: ingested ${filename}`
    await gitCommit(projectPath, message)
  } catch (err) {
    // Auto-commit is best-effort — don't break the ingest pipeline
    console.warn("[git-sync] auto-commit failed:", err)
  }
}
