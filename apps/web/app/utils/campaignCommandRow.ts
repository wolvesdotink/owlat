/**
 * Shared row model for the campaign command center. The page derives these rows
 * (attention roll-up + headline rates precomputed once) and the row component
 * renders them, so the type lives here where both can import it.
 */
import { api } from '@owlat/api';
import type { FunctionReturnType } from 'convex/server';
import type { CampaignAttentionReason } from '~/utils/campaignAttention';

/**
 * The exact campaign fields the command center's row + classifier read, derived
 * directly from the attention query's projected return shape
 * (`campaigns.organization.listAttentionCandidates`) so the two can never drift.
 * A full `Doc<'campaigns'>` from the paginated list is structurally assignable
 * to it — so one row model serves both data sources without dragging the heavy
 * per-campaign payload to the client.
 */
export type CampaignRowFields = FunctionReturnType<
	typeof api.campaigns.organization.listAttentionCandidates
>[number];

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
	campaign: CampaignRowFields;
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
