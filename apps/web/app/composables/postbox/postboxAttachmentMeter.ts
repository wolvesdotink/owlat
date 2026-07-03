/**
 * Total-size meter math for the composer attachment row. Pure (no Vue/Nuxt
 * context) so it can be unit-tested directly and reused by the composer chip UI.
 *
 * The per-message budget is the shared MTA/wire cap `MAX_ATTACHMENT_BYTES`. The
 * send path enforces BOTH an attachment COUNT cap and a combined-byte cap
 * (`ATTACHMENT_COMPOSE_LIMITS`), and the composer now gates the interactive add
 * path against the same limits; this meter is a softer visual nudge drawn against
 * the wire cap. It surfaces only once the total is worth worrying about (past
 * ~50% of budget) and turns amber as it nears the cap, nudging the user toward a
 * link for oversized files rather than a bounce at send time.
 */

import { MAX_ATTACHMENT_BYTES } from '@owlat/shared/attachments';

/** Per-message combined-size budget the meter is drawn against. */
export const ATTACHMENT_TOTAL_BUDGET_BYTES = MAX_ATTACHMENT_BYTES;

/** Show the meter once the combined size passes this fraction of the budget. */
export const ATTACHMENT_METER_SHOW_RATIO = 0.5;

/** Turn the meter amber (near-cap warning) at/above this fraction of budget. */
export const ATTACHMENT_METER_AMBER_RATIO = 0.85;

export interface AttachmentMeter {
	/** Combined size of all committed + in-flight attachments, in bytes. */
	totalBytes: number;
	/** The per-message budget the meter is measured against, in bytes. */
	budgetBytes: number;
	/** total / budget, clamped to >= 0 (can exceed 1 when over budget). */
	ratio: number;
	/** Whether the meter should be rendered at all. */
	visible: boolean;
	/** Near the cap: render amber and show the "use a link" hint. */
	amber: boolean;
	/** Combined size has exceeded the budget. */
	over: boolean;
}

/**
 * Derive meter state from a combined byte total. Defensive against a zero /
 * negative budget (returns a hidden, non-amber meter rather than dividing by 0).
 */
export function attachmentMeter(
	totalBytes: number,
	budgetBytes: number = ATTACHMENT_TOTAL_BUDGET_BYTES,
): AttachmentMeter {
	const total = Math.max(0, totalBytes);
	const budget = budgetBytes > 0 ? budgetBytes : 0;
	const ratio = budget > 0 ? total / budget : 0;
	return {
		totalBytes: total,
		budgetBytes: budget,
		ratio,
		visible: budget > 0 && total > budget * ATTACHMENT_METER_SHOW_RATIO,
		amber: budget > 0 && ratio >= ATTACHMENT_METER_AMBER_RATIO,
		over: budget > 0 && total > budget,
	};
}
