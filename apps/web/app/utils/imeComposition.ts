/**
 * True while an input method (Japanese, Chinese, Korean, …) owns the
 * keystroke: the Enter that confirms a candidate, the arrows that move through
 * candidates, the Escape that cancels the composition. A handler that maps
 * Enter to "send" or "commit" returns early on these, without
 * `preventDefault`, so the IME can finish.
 *
 * `isComposing` alone misses Safari, which fires the confirming Enter's keydown
 * after `compositionend`, when `isComposing` is already false; that keydown
 * still carries the IME's `keyCode` 229.
 */
export function isImeComposing(event: KeyboardEvent): boolean {
	return event.isComposing || event.keyCode === 229;
}
