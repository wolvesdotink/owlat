import type { Doc } from '../_generated/dataModel';

/**
 * Engagement predicates for campaign `emailSends` rows: the one rule behind
 * "delivered", "opened" and "clicked" in the campaign report, the click
 * heatmap and the A/B variant stats.
 *
 * Why timestamps, not `status`: `status` is the row's CURRENT state, and it
 * moves on as later events arrive (delivered → opened → clicked, or opened →
 * bounced / complained). Counting a bucket by `status` silently drops every
 * recipient who progressed past it, so an opened-then-bounced recipient would
 * vanish from the delivered denominator and every rate built on it would be
 * overstated. `deliveredAt`, `openedAt` and `clickedAt` are monotonic: once
 * set they are never cleared, so they answer "did this send ever reach X".
 *
 * The predicates nest: a clicked send has been opened or delivered, and any
 * opened or clicked send counts as delivered, so delivered >= opened and
 * delivered >= clicked and a rate over the delivered count never exceeds 100%.
 */
export type SendEngagementFields = Pick<
	Doc<'emailSends'>,
	'deliveredAt' | 'openedAt' | 'clickedAt' | 'clickedLinks'
>;

/**
 * "Ever reached delivered": a row carrying any delivered/opened/clicked
 * evidence passed through delivery, even if a later event moved its current
 * status. A row that only has `clickedLinks` counts too, so the delivered
 * count stays at least the clicked count.
 */
export function hasReachedDelivered(send: SendEngagementFields): boolean {
	return Boolean(send.deliveredAt) || hasOpened(send) || hasClicked(send);
}

/**
 * A reader opened the send (the open pixel fired), whatever its status is now.
 * Narrows `openedAt` to a number, so callers can read the open time directly.
 */
export function hasOpened<T extends SendEngagementFields>(
	send: T
): send is T & { openedAt: number } {
	return Boolean(send.openedAt);
}

/**
 * A reader clicked a tracked link. `clickedLinks` is checked as well as
 * `clickedAt` so a row whose click log was written without the first-click
 * timestamp still counts.
 */
export function hasClicked(send: SendEngagementFields): boolean {
	return Boolean(send.clickedAt) || (send.clickedLinks?.length ?? 0) > 0;
}
