/**
 * [2] DNSBL halt-and-alert rendering.
 *
 * The "every sending address is blocklisted" alert is the one alert that must
 * never be dropped, so its message is built to fit Convex ingress BY
 * CONSTRUCTION rather than by hoping it stays short.
 */

import { MTA_WEBHOOK_MESSAGE_MAX_LENGTH } from '@owlat/shared/mtaWebhookEvent';

/**
 * Convex ingress validates `message` with `bounded(message, …)` and rejects the
 * ENTIRE webhook event when it is longer (see packages/shared/src/mtaWebhookEvent.ts).
 * The bound is imported, not re-declared, so the two can never drift apart.
 */
export const ALERT_MESSAGE_MAX_LENGTH = MTA_WEBHOOK_MESSAGE_MAX_LENGTH;

/** One sending address and the zones that listed it (empty = unmeasured). */
export interface DnsblListing {
	ip: string;
	zones: string[];
}

/**
 * Render `<ip> on <zones>` clauses for as many addresses as fit in `budget`,
 * closing with `and K more` when the pool is larger than the budget allows.
 */
export function boundedListingDetail(listings: readonly DnsblListing[], budget: number): string {
	const clauses = listings.map(
		({ ip, zones }) =>
			`${ip} on ${zones.length > 0 ? zones.join(', ') : 'an unmeasured blocklist status'}`
	);
	const rendered: string[] = [];
	for (const [index, clause] of clauses.entries()) {
		const remaining = clauses.length - index - 1;
		const candidate =
			[...rendered, clause].join('; ') + (remaining > 0 ? `; and ${remaining} more` : '');
		if (candidate.length > budget) break;
		rendered.push(clause);
	}
	const omitted = clauses.length - rendered.length;
	// Even one clause can overflow a pathologically long zone list: fall back to
	// the count, which always fits and still tells the operator the scale.
	if (rendered.length === 0) return `${clauses.length} sending addresses`;
	return omitted > 0 ? `${rendered.join('; ')}; and ${omitted} more` : rendered.join('; ');
}
