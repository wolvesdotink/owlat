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
 *
 * The table is module scope, so it never calls `useI18n`: `label`, `headline`
 * and the sentence `phrase` returns are catalog KEYS (the phrase carries its
 * date as a parameter), and each surface resolves them with `t()` at render
 * time.
 */

import type { Doc } from '@owlat/api/dataModel';

/**
 * The `blockedEmails.reason` union, DERIVED from the schema rather than
 * mirrored. A hand-written copy would go on compiling when a fifth literal is
 * added, which is the exact failure the `satisfies` below promises to catch.
 */
export type BlockReason = Doc<'blockedEmails'>['reason'];

/** A translatable sentence: a catalog key plus the values its message fills in. */
export type SuppressionReasonText = { key: string; params?: Record<string, string> };

export type SuppressionReasonPresentation = {
	/** Badge classes for the suppression table. */
	badge: string;
	/** Icon tint used outside the badge (stat tiles, row icon). */
	tone: string;
	icon: string;
	/** Plain-language label — explains WHY, no jargon. A catalog key. */
	label: string;
	/**
	 * The notice HEADLINE on the contact profile — what this suppression actually
	 * stops. Not constant across reasons: `unengaged` is a MARKETING-ONLY hygiene
	 * row (`isMarketingOnlyBlockReason`, apps/api/convex/delivery/suppressionMirror.ts),
	 * so that address still receives transactional mail, double-opt-in
	 * confirmations and 1:1 agent replies. Saying "not receiving mail" there would
	 * push the operator into a manual removal they do not need.
	 */
	headline: string;
	/**
	 * The inline phrase used mid-sentence on the contact profile, e.g.
	 * "…— bounced on Mar 3.". Takes the pre-formatted date label and hands back
	 * the message key plus that date.
	 */
	phrase: (dateLabel: string) => SuppressionReasonText;
};

const SUPPRESSION_REASON_PRESENTATION = {
	bounced: {
		headline: 'shared.suppressionReasons.headline.noMail',
		badge: 'bg-error/20 text-error border-error/30',
		tone: 'text-error',
		icon: 'lucide:mail',
		label: 'shared.suppressionReasons.bounced.label',
		phrase: (dateLabel: string) => ({
			key: 'shared.suppressionReasons.bounced.phrase',
			params: { date: dateLabel },
		}),
	},
	complained: {
		headline: 'shared.suppressionReasons.headline.noMail',
		badge: 'bg-warning/20 text-warning border-warning/30',
		tone: 'text-warning',
		icon: 'lucide:message-square-warning',
		label: 'shared.suppressionReasons.complained.label',
		phrase: (dateLabel: string) => ({
			key: 'shared.suppressionReasons.complained.phrase',
			params: { date: dateLabel },
		}),
	},
	unengaged: {
		headline: 'shared.suppressionReasons.headline.noCampaigns',
		badge: 'bg-bg-elevated text-text-secondary border-border-default',
		tone: 'text-text-secondary',
		icon: 'lucide:moon',
		label: 'shared.suppressionReasons.unengaged.label',
		phrase: (dateLabel: string) => ({
			key: 'shared.suppressionReasons.unengaged.phrase',
			params: { date: dateLabel },
		}),
	},
	manual: {
		headline: 'shared.suppressionReasons.headline.noMail',
		badge: 'bg-brand/20 text-brand border-brand/30',
		tone: 'text-brand',
		icon: 'lucide:user-x',
		label: 'shared.suppressionReasons.manual.label',
		phrase: (dateLabel: string) => ({
			key: 'shared.suppressionReasons.manual.phrase',
			params: { date: dateLabel },
		}),
	},
} as const satisfies Record<BlockReason, SuppressionReasonPresentation>;

/** Total lookup — no fallback, because the union admits no other value. */
export function suppressionReasonPresentation(reason: BlockReason): SuppressionReasonPresentation {
	return SUPPRESSION_REASON_PRESENTATION[reason];
}
