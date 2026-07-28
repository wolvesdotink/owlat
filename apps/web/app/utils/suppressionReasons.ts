/**
 * ONE table for "why is this address suppressed", shared by every surface that
 * has to say it. `blockedEmails.reason` (apps/api/convex/schema/delivery.ts) is
 * a closed union, so the presentation of a reason is a total function of it —
 * and the table below is declared `satisfies Record<BlockReason, …>` so adding a
 * fifth literal to the schema is a COMPILE ERROR here rather than a silent
 * fallback to "Manually suppressed".
 *
 * This replaces the parallel switches that had grown in the suppression list
 * and the contact-profile notice: the same decision made twice drifts the
 * moment a reason is added, which is exactly what happened when the sunset
 * engine introduced 'unengaged'.
 */

import type { Doc } from '@owlat/api/dataModel';

/**
 * The `blockedEmails.reason` union, DERIVED from the schema rather than
 * mirrored. A hand-written copy would go on compiling when a fifth literal is
 * added, which is the exact failure the `satisfies` below promises to catch.
 */
export type BlockReason = Doc<'blockedEmails'>['reason'];

export type SuppressionReasonPresentation = {
	/** Badge classes for the suppression table. */
	badge: string;
	/** Icon tint used outside the badge (stat tiles, row icon). */
	tone: string;
	icon: string;
	/** Plain-language label — explains WHY, no jargon. */
	label: string;
	/**
	 * The inline phrase used mid-sentence on the contact profile, e.g.
	 * "…— bounced on Mar 3.". Takes the pre-formatted date label.
	 */
	phrase: (dateLabel: string) => string;
};

export const SUPPRESSION_REASON_PRESENTATION = {
	bounced: {
		badge: 'bg-error/20 text-error border-error/30',
		tone: 'text-error',
		icon: 'lucide:mail',
		label: "Bounced — mailbox doesn't exist",
		phrase: (dateLabel: string) => `bounced on ${dateLabel}`,
	},
	complained: {
		badge: 'bg-warning/20 text-warning border-warning/30',
		tone: 'text-warning',
		icon: 'lucide:message-square-warning',
		label: 'Complained — marked a send as spam',
		phrase: (dateLabel: string) => `complained on ${dateLabel}`,
	},
	unengaged: {
		badge: 'bg-bg-elevated text-text-secondary border-border',
		tone: 'text-text-secondary',
		icon: 'lucide:moon',
		label: 'Unengaged — ignored every message for months',
		phrase: (dateLabel: string) => `paused on ${dateLabel} after months with no opens or clicks`,
	},
	manual: {
		badge: 'bg-brand/20 text-brand border-brand/30',
		tone: 'text-brand',
		icon: 'lucide:user-x',
		label: 'Manually suppressed',
		phrase: (dateLabel: string) => `manually suppressed on ${dateLabel}`,
	},
} as const satisfies Record<BlockReason, SuppressionReasonPresentation>;

/** Total lookup — no fallback, because the union admits no other value. */
export function suppressionReasonPresentation(reason: BlockReason): SuppressionReasonPresentation {
	return SUPPRESSION_REASON_PRESENTATION[reason];
}
