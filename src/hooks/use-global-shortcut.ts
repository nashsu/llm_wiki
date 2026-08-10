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

import { useEffect, useRef } from "react"

export interface ShortcutDefinition {
  callback: () => void
  /** Application commands such as Settings should work while typing. */
  allowInTextInput?: boolean
}

export interface ShortcutMap {
  [key: string]: (() => void) | ShortcutDefinition
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
function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  const element = target.closest("input, textarea, [contenteditable='true'], [role='textbox']")
  if (!element) return false

  const tag = element.tagName.toLowerCase()
  if (tag === "textarea") return true
  if (tag === "input") {
    const inputType = (element as HTMLInputElement).type
    // Allow shortcuts on checkboxes, radio buttons, and buttons
    return !["checkbox", "radio", "submit", "button", "reset"].includes(inputType)
  }
  if (element instanceof HTMLElement && element.isContentEditable) return true
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
  const shortcutsRef = useRef(shortcuts)
  useEffect(() => {
    shortcutsRef.current = shortcuts
  }, [shortcuts])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Suppress shortcuts during IME composition (e.g., typing Chinese characters)
      // Check both modern isComposing and legacy keyCode 229 signal (matches isImeComposing pattern)
      if (event.isComposing || event.keyCode === 229) {
        return
      }

      // Check if the pressed key has a registered shortcut
      const key = event.key.toLowerCase()
      const definition = shortcutsRef.current[key]
      if (!definition) return
      const callback = typeof definition === "function" ? definition : definition.callback
      const allowInTextInput = typeof definition === "function"
        ? false
        : definition.allowInTextInput === true

      if (!allowInTextInput && isTextInput(event.target)) return

      // Require platform-appropriate modifier key (Cmd on macOS, Ctrl on others)
      // This prevents triggering shortcuts during normal typing
      if (!hasPlatformModifierKey(event)) return

      // Prevent default browser behavior and execute the callback
      event.preventDefault()
      callback()
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => {
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [])
}
