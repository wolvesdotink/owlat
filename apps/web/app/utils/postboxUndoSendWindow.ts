/**
 * Postbox undo-send window — how long a sent message is held before it actually
 * dispatches, and therefore how long "Undo" stays on offer.
 *
 * The backend has accepted `undoSendDelayMs` on `mail.drafts.send` since the
 * draft lifecycle was written; nothing on the web ever passed it, so every user
 * lived with the server default (`DEFAULT_UNDO_SEND_DELAY_MS`, 30s). This module
 * is the whole preference: a CLOSED set of four windows, the mapping to the
 * wire argument, and the rule that decides whether an undo toast exists at all.
 *
 * Four values rather than a free number because the control is four radio
 * choices and an arbitrary window (seven hours) is a footgun, not a preference.
 *
 * Two invariants the tests pin, both of them "absent = exactly today's
 * behaviour":
 *   - an unset preference resolves to {@link POSTBOX_UNDO_SEND_DEFAULT_SECONDS}
 *     (30s), the server default; and
 *   - the default window sends NO `undoSendDelayMs` at all, so a user who never
 *     touches the setting produces the byte-identical mutation call they
 *     produced before the control existed.
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
 * The window an unset preference means. Matches the server's
 * `DEFAULT_UNDO_SEND_DELAY_MS` (30_000ms) — the hold every user already had.
 */
export const POSTBOX_UNDO_SEND_DEFAULT_SECONDS: PostboxUndoSendSeconds = 30;

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
 * sending NOTHING: a user on the default keeps the exact mutation shape they
 * had before this preference existed, and the server keeps owning the number.
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
