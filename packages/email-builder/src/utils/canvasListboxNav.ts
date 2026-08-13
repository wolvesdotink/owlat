/**
 * Pure helpers for the canvas listbox keyboard navigation.
 *
 * Extracted from DocumentCanvas.vue so the selection math is unit-testable on
 * its own and the component stays under the repo's file-size guideline.
 */

/**
 * True when the event target is a control that owns its own key handling, so
 * canvas-level navigation must stand down (typing in a field must not move the
 * block selection).
 */
export function isEditableTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable) return true;
	return ['input', 'textarea', 'select'].includes(target.tagName.toLowerCase());
}

/**
 * Index the selection moves to for a listbox navigation key, or `null` when the
 * key is not a navigation key. Movement is clamped at both ends (no wrapping),
 * and with nothing selected (`current < 0`) ArrowDown enters at the top while
 * ArrowUp enters at the bottom.
 */
export function nextListboxIndex(key: string, current: number, length: number): number | null {
	if (length === 0) return null;
	if (key === 'ArrowDown') return current < 0 ? 0 : Math.min(current + 1, length - 1);
	if (key === 'ArrowUp') return current < 0 ? length - 1 : Math.max(current - 1, 0);
	if (key === 'Home') return 0;
	if (key === 'End') return length - 1;
	return null;
}
