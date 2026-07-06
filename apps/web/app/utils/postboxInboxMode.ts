/**
 * Postbox inbox landing mode — which surface the inbox route shows when no
 * message is open:
 *
 *   - 'today'  → PostboxTodayView (focused single-column landing view; the
 *                default). One task at a time: the Brief, "For you" agent
 *                strips, today's mail, and everything else behind a "Show
 *                past mails" affordance.
 *   - 'browse' → the existing full three-pane folder UI (rail + list +
 *                reader), for browsing/bulk work.
 *
 * Inbox-only: every other folder always renders the three-pane UI, so the
 * mode is a stored preference of the person (last-used mode), not a
 * per-folder property. Pure derivations so the mapping stays unit-testable
 * without mounting the Convex-backed layout.
 */

export type PostboxInboxMode = 'today' | 'browse';

export const POSTBOX_INBOX_MODE_DEFAULT: PostboxInboxMode = 'today';

/** Normalise a stored/unknown value to a valid inbox mode, defaulting safely. */
export function resolvePostboxInboxMode(value: string | undefined | null): PostboxInboxMode {
	return value === 'browse' ? value : POSTBOX_INBOX_MODE_DEFAULT;
}
