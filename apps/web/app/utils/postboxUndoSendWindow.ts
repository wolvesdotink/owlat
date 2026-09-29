/**
 * Postbox undo-send window — how long a sent message is held before it actually
 * dispatches, and therefore how long "Undo" stays on offer.
 *
 * The backend accepts `undoSendDelayMs` on `mail.drafts.send` and falls back to
 * its own default (`DEFAULT_UNDO_SEND_DELAY_MS`, 10s) when it is absent. This
 * module is the whole preference: a CLOSED set of four windows, the mapping to
 * the wire argument, and the rule that decides whether an undo toast exists at
 * all.
 *
 * Four values rather than a free number because the control is four radio
 * choices and an arbitrary window (seven hours) is a footgun, not a preference.
 *
 * Invariants the tests pin:
 *   - an unset preference resolves to {@link POSTBOX_UNDO_SEND_DEFAULT_SECONDS}
 *     (10s), the server default;
 *   - the default window sends NO `undoSendDelayMs` at all, so the server keeps
 *     owning the number for a user who never touched the setting; and
 *   - every other stored window (30/60 included, the old default) is sent
 *     explicitly, so lowering the default (plan Q1, 30s -> 10s) moved only the
 *     users on the implicit default and nobody who picked a window.
 *
 * 'Off' (0s) is a real choice, not a disabled feature: the message dispatches
 * immediately and {@link postboxUndoSendShowsToast} is false, so the composer
 * shows no countdown it could not honour. Pure derivations — no Convex, no
 * component — so the semantics are unit-testable on their own.
 */

/** The four windows offered, in seconds. `0` is Off (no hold, no toast). */
export const POSTBOX_UNDO_SEND_SECONDS = [0, 10, 30, 60] as const;

export type PostboxUndoSendSeconds = (typeof POSTBOX_UNDO_SEND_SECONDS)[number];

/**
 * The window an unset preference means. Must match the server's
 * `DEFAULT_UNDO_SEND_DELAY_MS` (10_000ms): the default is expressed by sending
 * nothing, so a mismatch would show one window and hold for another.
 */
export const POSTBOX_UNDO_SEND_DEFAULT_SECONDS: PostboxUndoSendSeconds = 10;

/** Normalise a stored/unknown value to one of the four windows, defaulting safely. */
export function resolvePostboxUndoSendSeconds(
	value: number | undefined | null
): PostboxUndoSendSeconds {
	return POSTBOX_UNDO_SEND_SECONDS.includes(value as PostboxUndoSendSeconds)
		? (value as PostboxUndoSendSeconds)
		: POSTBOX_UNDO_SEND_DEFAULT_SECONDS;
}

/**
 * What `send()` should put on the wire. The DEFAULT window is expressed by
 * sending NOTHING, so the server keeps owning the number.
 * Every other window (Off included — `0` is meaningful and must survive) is
 * sent explicitly in milliseconds.
 */
export function postboxUndoSendDelayMsArg(seconds: PostboxUndoSendSeconds): number | undefined {
	return seconds === POSTBOX_UNDO_SEND_DEFAULT_SECONDS ? undefined : seconds * 1000;
}

/**
 * Whether a send with this window has an undo toast to show. Off has no hold,
 * so there is no window to count down and nothing to cancel — the composer must
 * not offer an Undo it cannot honour. (The toast component independently hides
 * itself once the remaining time hits zero; this is the same rule stated where
 * the preference lives, so a caller can decide BEFORE arming anything.)
 */
export function postboxUndoSendShowsToast(seconds: PostboxUndoSendSeconds): boolean {
	return seconds > 0;
}
