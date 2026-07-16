/**
 * Returns true when a keydown event is part of an IME composition
 * (Chinese / Japanese / Korean input methods). When the user is
 * composing — e.g. typing English letters under a Chinese input
 * method to pick a candidate — pressing Enter commits the
 * candidate, but the same Enter keydown ALSO bubbles up to the
 * input element and gets misread by `if (e.key === "Enter")`
 * handlers as a "submit" intent. Result: the message sends
 * before the user actually finished typing.
 *
 * Both signals are required because no single one is reliable:
 *   - `nativeEvent.isComposing` — W3C standard, true while the
 *     IME is composing. Cleared by the time the commit-press
 *     fires in some browsers.
 *   - `keyCode === 229` — the legacy "IME activity" signal that
 *     Chromium continues to emit on the commit-press itself,
 *     after `isComposing` has already flipped back to false.
 *
 * Use this in every Enter-as-submit handler on a text input so
 * IME composition Enter never leaks through as a submit.
 */
export function isImeComposing(e: React.KeyboardEvent): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229
}
