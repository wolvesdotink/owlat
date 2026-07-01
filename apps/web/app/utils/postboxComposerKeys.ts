/**
 * Keyboard shortcut resolution for the Postbox composer.
 *
 * Pure function so the shortcut semantics are unit-testable without mounting
 * the (Convex-backed) composer component:
 * - Cmd/Ctrl+Enter        → send (same guarded path as the Send button)
 * - Cmd/Ctrl+Shift+Enter  → open the schedule-send dialog
 * - Escape                → minimize the popup composer, but ONLY when no
 *                           inner overlay (schedule dialog, recipient
 *                           autocomplete, native select dropdown) is open —
 *                           the overlay gets to close first.
 */

export type ComposerKeyAction = 'send' | 'schedule' | 'minimize';

export interface ComposerKeyContext {
	/**
	 * True when sending is currently allowed — same predicate that enables the
	 * Send button (recipients present, not already sending, not scheduled).
	 */
	canSend: boolean;
	/** True when a dialog/dropdown inside the composer is open. */
	overlayOpen: boolean;
}

type KeyEventLike = Pick<
	KeyboardEvent,
	'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'
>;

export function resolveComposerKeyAction(
	event: KeyEventLike,
	ctx: ComposerKeyContext,
): ComposerKeyAction | null {
	const mod = event.metaKey || event.ctrlKey;

	if (event.key === 'Enter' && mod && !event.altKey) {
		// Respect the same guards as the Send / Schedule buttons: a disabled
		// button must not be bypassable via the shortcut.
		if (!ctx.canSend) return null;
		return event.shiftKey ? 'schedule' : 'send';
	}

	if (event.key === 'Escape' && !mod && !event.shiftKey && !event.altKey) {
		// An open inner overlay owns Escape — closing it wins over minimize.
		if (ctx.overlayOpen) return null;
		return 'minimize';
	}

	return null;
}
