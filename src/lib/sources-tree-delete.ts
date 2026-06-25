/**
 * Pure helpers for the SourcesView delete flow.
 *
 * Extracted out of `sources-view.tsx` so they're testable without
 * spinning up React Testing Library / @testing-library/react —
 * neither of which is currently a project dependency. The actual
 * click handlers and state in the component are thin glue around
 * these functions; visual review covers the wiring, unit tests
 * cover the decision logic.
 */
import type { FileNode } from "@/types/wiki"

/**
 * Recursively collect every leaf (non-directory) file under
 * `folder`. Walks `folder.children` rather than re-reading the
 * file system — the parent already filters hidden source noise before
 * the tree reaches the UI, so this preserves
 * the "delete exactly what the user saw" invariant.
 *
 * Skips empty folders (returns no entries for them) but recurses
 * into populated subdirectories regardless of nesting depth.
 */
export function collectAllFilesIncludingDot(folder: FileNode): FileNode[] {
  const out: FileNode[] = []
  function walk(node: FileNode) {
    if (node.is_dir) {
      if (node.children) {
        for (const c of node.children) walk(c)
      }
    } else {
      out.push(node)
    }
  }
  walk(folder)
  return out
}

/**
 * Decision returned by the two-stage delete-button click logic.
 * The component reads this and (a) calls the appropriate handler,
 * (b) updates `pendingDeletePath` to match.
 *
 *   - "arm"          : first click on this node — set pending,
 *                      visually flip the button to "Confirm"
 *   - "fire-file"    : second click on the same FILE node — call
 *                      onDelete + clear pending
 *   - "fire-folder"  : second click on the same FOLDER node — call
 *                      onDeleteFolder + clear pending
 */
export type DeleteClickAction =
  | { kind: "arm"; path: string }
  | { kind: "fire-file"; node: FileNode }
  | { kind: "fire-folder"; node: FileNode }

/**
 * Pure state-machine for the inline delete-confirm button.
 *
 *   currentPending === clicked.path  → second click → fire
 *   else                             → first click → arm
 *
 * Folder vs file dispatch is on `clicked.is_dir` so the parent
 * doesn't need to branch explicitly — one button, one click
 * handler, the action shape tells the component which prop to
 * call.
 */
export function decideDeleteClick(
  currentPending: string | null,
  clicked: FileNode,
): DeleteClickAction {
  if (currentPending === clicked.path) {
    return clicked.is_dir
      ? { kind: "fire-folder", node: clicked }
      : { kind: "fire-file", node: clicked }
  }
  return { kind: "arm", path: clicked.path }
}
