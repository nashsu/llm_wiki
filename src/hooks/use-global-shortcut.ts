/**
 * React hook for handling global keyboard shortcuts.
 *
 * Registers window-level keyboard event listeners that trigger callbacks
 * when specific key combinations are pressed. Shortcuts are global within
 * the application (work from any view) but are automatically suppressed when
 * the user is typing in text input fields to avoid interference.
 *
 * @example
 * ```ts
 * useGlobalShortcut({
 *   ",": () => setActiveView("settings"),
 * })
 * ```
 *
 * Platform conventions:
 * - macOS: Cmd (⌘) + key
 * - Windows/Linux: Ctrl + key
 */

import { useEffect, useCallback } from "react"

export interface ShortcutMap {
  [key: string]: () => void
}

/**
 * Check if an element is a text input field that should suppress global shortcuts.
 *
 * Returns true for:
 * - <input> elements (except checkboxes/radio/buttons)
 * - <textarea> elements
 * - Elements with contentEditable="true"
 * - Elements with role="textbox"
 */
function isTextInput(element: HTMLElement | null): boolean {
  if (!element) return false

  const tag = element.tagName.toLowerCase()
  if (tag === "textarea") return true
  if (tag === "input") {
    const inputType = (element as HTMLInputElement).type
    // Allow shortcuts on checkboxes, radio buttons, and buttons
    return !["checkbox", "radio", "submit", "button", "reset"].includes(inputType)
  }
  if (element.isContentEditable) return true
  if (element.getAttribute("role") === "textbox") return true

  return false
}

/**
 * Check if the event has the appropriate modifier key for the current platform.
 *
 * - macOS: Requires event.metaKey (Cmd)
 * - Windows/Linux: Requires event.ctrlKey
 */
function hasPlatformModifierKey(event: KeyboardEvent): boolean {
  // Reuse the platform class already set in main.tsx
  const isMac = document.documentElement.classList.contains("platform-macos")
  return isMac ? event.metaKey : event.ctrlKey
}

/**
 * Register global keyboard shortcuts.
 *
 * @param shortcuts - Map of key names to callback functions
 *
 * Keys should be lowercase event.key values (e.g., "," for comma, "s" for S key).
 *
 * Shortcuts are suppressed when:
 * - User is typing in a text input field
 * - User is composing text via IME (Chinese/Japanese/Korean input methods)
 */
export function useGlobalShortcut(shortcuts: ShortcutMap): void {
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      // Suppress shortcuts when user is typing in a text input field
      if (isTextInput(document.activeElement as HTMLElement | null)) {
        return
      }

      // Suppress shortcuts during IME composition (e.g., typing Chinese characters)
      // Check both modern isComposing and legacy keyCode 229 signal (matches isImeComposing pattern)
      if (event.isComposing || event.keyCode === 229) {
        return
      }

      // Check if the pressed key has a registered shortcut
      const key = event.key.toLowerCase()
      const callback = shortcuts[key]
      if (!callback) return

      // Require platform-appropriate modifier key (Cmd on macOS, Ctrl on others)
      // This prevents triggering shortcuts during normal typing
      if (!hasPlatformModifierKey(event)) return

      // Prevent default browser behavior and execute the callback
      event.preventDefault()
      callback()
    },
    [shortcuts],
  )

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown)
    return () => {
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [handleKeyDown])
}
