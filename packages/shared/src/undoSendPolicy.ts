/**
 * Postbox undo-send policy — the windows a user may pick and the one an unset
 * preference means, as ONE set of numbers.
 *
 * Read by the web settings control and composer
 * (`apps/web/app/utils/postboxUndoSendWindow.ts`, and through it the offline
 * outbox's `OFFLINE_QUEUE_UNDO_WINDOW_MS`), the Convex validator that guards the
 * stored preference (`mailUndoSendSecondsValidator`), and the draft lifecycle's
 * scheduling fallback (`DEFAULT_UNDO_SEND_DELAY_MS`). The composer
 * expresses the default by sending NO delay, so a client and server that
 * disagree on the default would show one countdown and hold for another.
 *
 * Seconds, because that is the stored unit (`mailUserSettings.undoSendSeconds`)
 * and the unit the control shows; each owner converts to milliseconds itself.
 * Only the numbers live here: the countdown, the wire rule and the scheduling
 * stay with the modules that own them.
 */

/**
 * The windows offered, in seconds. `0` is Off: dispatch immediately, no undo
 * toast. A closed set because the control is a handful of choices and an
 * arbitrary hold (seven hours) is a footgun, not a preference. These values are
 * stored on existing rows, so removing or renumbering one is a schema change.
 */
export const UNDO_SEND_SECOND_CHOICES = [0, 10, 30, 60] as const;

export type UndoSendSeconds = (typeof UNDO_SEND_SECOND_CHOICES)[number];

/**
 * The window an unset preference means. 10 s (plan Q1, was 30 s): long enough
 * to catch a slip, short enough that the recipient does not wait.
 */
export const DEFAULT_UNDO_SEND_SECONDS: UndoSendSeconds = 10;
