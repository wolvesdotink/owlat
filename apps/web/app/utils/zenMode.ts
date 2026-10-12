/**
 * Keyboard rules for Zen mode (see composables/useZenMode.ts), kept pure so the
 * Esc arbitration can be tested without a page.
 *
 * Esc means a dozen things in this app: close a dialog or a menu, put the open
 * conversation away, leave Answer mode, go from All mail back to Priority,
 * leave a text field. One press does one of them, in this order: whatever
 * overlay is open, then the text being typed (or the IME composing it), then
 * Zen itself, and only then the page. So in Zen the first Esc brings the app
 * back and the second one closes the conversation.
 */

export interface ZenEscapePress {
	/** An IME is composing; Esc belongs to it. */
	composing: boolean;
	/** The key went down inside a text field or a contenteditable. */
	editable: boolean;
	/** A dialog or a menu is open. */
	overlayOpen: boolean;
	/**
	 * The page is chrome-less on its own terms and owns Esc there (Answer mode,
	 * the email builder's focus mode): leaving Zen would change nothing visible.
	 */
	pageOwnsEscape: boolean;
}

/** Whether Zen takes this Esc press (and nothing else gets it). */
export function zenTakesEscape(press: ZenEscapePress): boolean {
	return !press.composing && !press.editable && !press.overlayOpen && !press.pageOwnsEscape;
}

export interface ZenChordEvent {
	key: string;
	metaKey?: boolean;
	ctrlKey?: boolean;
	altKey?: boolean;
	shiftKey?: boolean;
}

/**
 * Cmd/Ctrl+Shift+F. Matched on the letter, case-insensitively: with Shift held
 * most browsers report `F`, some keep `f`.
 */
export function isZenChord(event: ZenChordEvent): boolean {
	return (
		!!(event.metaKey || event.ctrlKey) &&
		!!event.shiftKey &&
		!event.altKey &&
		event.key.toLowerCase() === 'f'
	);
}

/** Something on screen that owns Esc before Zen does. */
export function isOverlayOpen(root: ParentNode = document): boolean {
	return root.querySelector('[role="dialog"], [role="menu"]') !== null;
}
