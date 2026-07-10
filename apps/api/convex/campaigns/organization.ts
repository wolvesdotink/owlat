import type { Doc } from '../_generated/dataModel';
import { authedQuery } from '../lib/authedFunctions';
import { assertFeatureEnabled } from '../lib/featureFlags';
import { countFacet } from '../lib/listing';
import { campaignListing } from './listing';

// Query to count campaigns by status (API-key shell) — the descriptor's
// `byStatus` facet returns per-status counts plus their `total`.
export const countByStatusByOrganization = authedQuery({
	args: {},
	handler: async (ctx) => {
		const counts = await countFacet(ctx.db, campaignListing, 'byStatus');
		return counts as Record<string, number>;
	},
});

// A campaign only ever "needs a human decision" while it sits in one of these
// low-cardinality, inherently transient states: scheduled (going out), sending
// (an A/B split awaiting its winner), cancelled (a stopped send), or
// pending_review. The high-volume browse states (draft / sent) are never a
// primary attention state, so the command center can classify attention over
// the WHOLE candidate set — not just the loaded page — without scanning every
// campaign. This keeps the "Needs attention empty ⇔ nothing needs you" promise
// honest even past the first page of a large org.
const ATTENTION_CANDIDATE_STATUSES = [
	'scheduled',
	'sending',
	'cancelled',
	'pending_review',
] as const;

// Only the fields the command center's attention classifier + row actually
// read. Projecting keeps the live subscription off the heavy per-campaign
// payload (archiveHtmlContent, the frozen `audience` snapshot, abTestConfig),
// so a large cancelled backlog carrying archived HTML can't push the result
// toward Convex's function-result cap.
export type AttentionCandidate = Pick<
	Doc<'campaigns'>,
	| '_id'
	| 'name'
	| 'subject'
	| 'status'
	| 'scheduledAt'
	| 'sentAt'
	| 'isABTest'
	| 'abTestStatus'
	| 'abWinner'
	| 'contentBlockReason'
	| 'updatedAt'
	| 'statsSent'
	| 'statsDelivered'
	| 'statsOpened'
	| 'statsClicked'
	| 'abVariantBSent'
	| 'abVariantBOpened'
>;

function projectCandidate(c: Doc<'campaigns'>): AttentionCandidate {
	return {
		_id: c._id,
		name: c.name,
		subject: c.subject,
		status: c.status,
		scheduledAt: c.scheduledAt,
		sentAt: c.sentAt,
		isABTest: c.isABTest,
		abTestStatus: c.abTestStatus,
		abWinner: c.abWinner,
		contentBlockReason: c.contentBlockReason,
		updatedAt: c.updatedAt,
		statsSent: c.statsSent,
		statsDelivered: c.statsDelivered,
		statsOpened: c.statsOpened,
		statsClicked: c.statsClicked,
		abVariantBSent: c.abVariantBSent,
		abVariantBOpened: c.abVariantBOpened,
	};
}

// Return the projected candidate set the client's attention classifier
// (utils/campaignAttention.ts, the source of truth) then filters over.
// all-members: org-wide, same visibility as the campaign list. Gated on the
// `campaigns` feature for parity with the sibling `campaigns.campaigns.list`
// that serves the same surface's browse pills.
export const listAttentionCandidates = authedQuery({
	args: {},
	handler: async (ctx) => {
		await assertFeatureEnabled(ctx, 'campaigns');
		const out: AttentionCandidate[] = [];
		for (const status of ATTENTION_CANDIDATE_STATUSES) {
			// bounded: each attention state is transient/small; capped well above
			// any real count so the scan can never run unbounded.
			const batch = await ctx.db
				.query('campaigns')
				.withIndex('by_status', (q) => q.eq('status', status))
				.take(1000);
			out.push(...batch.map(projectCandidate));
		}
		return out;
	},
});

// Aggregate stats across ALL sent campaigns, so the Reports summary cards are
// correct beyond the first page of the list (the page used to sum only the
// loaded 100). Reads the denormalized per-campaign stat fields.
// all-members: org-wide campaign reporting totals, same visibility as the list.
export const getSentSummary = authedQuery({
	args: {},
	handler: async (ctx) => {
		// bounded: org-wide sent-campaign scan, capped well above any real count.
		const sent = await ctx.db
			.query('campaigns')
			.withIndex('by_status', (q) => q.eq('status', 'sent'))
			.take(5000);
		let totalSent = 0;
		let totalDelivered = 0;
		let totalOpened = 0;
		let totalClicked = 0;
		for (const c of sent) {
			totalSent += c.statsSent ?? 0;
			totalDelivered += c.statsDelivered ?? 0;
			totalOpened += c.statsOpened ?? 0;
			totalClicked += c.statsClicked ?? 0;
		}
		return { totalCampaigns: sent.length, totalSent, totalDelivered, totalOpened, totalClicked };
	},
});

// Audience recipient counts moved to the Audience resolution (module) at
// `campaigns/audienceResolution.ts:countRecipients` (ADR-0033) — it runs the
// identical eligibility predicate as the send path, so the count can no longer
// over-report. The wizard calls `countRecipients({ audience })` directly.
