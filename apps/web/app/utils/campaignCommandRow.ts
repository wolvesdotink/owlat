/**
 * Shared row model for the campaign command center. The page derives these rows
 * (attention roll-up + headline rates precomputed once) and the row component
 * renders them, so the type lives here where both can import it.
 */
import type { Doc } from '@owlat/api/dataModel';
import type { CampaignAttentionReason } from '~/utils/campaignAttention';

/** One roll-up attention chip: its label + status-dot utility class. */
export interface ReasonChip {
	label: string;
	dot: string;
}

/** The rendered status badge (mirrors `useCampaignStatusBadge`'s shape). */
export interface RowStatusBadge {
	color: string;
	icon: string;
	label: string;
}

export interface DecoratedRow {
	campaign: Doc<'campaigns'>;
	needsAttention: boolean;
	reason: CampaignAttentionReason | null;
	/** Precomputed chip for the reason (or null) — keeps the template out of a
	 * possibly-null index access. */
	reasonChip: ReasonChip | null;
	/** Precomputed status badge — kills repeated template calls + casts. */
	statusBadge: RowStatusBadge;
	actionLabel: string | null;
	openRate: number | null;
	clickRate: number | null;
	/** Variant open rates (A = main stats, B = abVariantB*) — computed once and
	 * reused by both the sparkline and the meta line. */
	variantA: number | null;
	variantB: number | null;
	/** Variant open-rate mini-trend for A/B sends; empty ⇒ sparkline hidden. */
	spark: number[];
}
