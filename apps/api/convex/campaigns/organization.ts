import type { Doc } from '../_generated/dataModel';
import { campaignsQuery } from './_helpers';
import { countFacet } from '../lib/listing';
import { campaignListing } from './listing';

// Query to count campaigns by status (API-key shell) — the descriptor's
// `byStatus` facet returns per-status counts plus their `total`.
export const countByStatusByOrganization = campaignsQuery({
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

// `cancelled` is terminal, so unlike the other three states it never drains:
// every stopped send would stay a candidate forever and the scan would grow
// with the org's age. A stop is only worth reviving while it is recent, so the
// cancelled bucket is the ones touched in the last 30 days, read as an index
// range on `updatedAt` (plan C10). Older ones stay under the Cancelled pill.
export const CANCELLED_ATTENTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// bounded: each attention state is transient/small (cancelled by the window
// above); capped well above any real count so the scan can never run unbounded.
const ATTENTION_CANDIDATE_CAP = 1000;

// Only the fields the command center's attention classifier + row actually
// read. Projecting keeps the live subscription off the heavy per-campaign
// payload (archiveHtmlContent, the frozen `audience` snapshot, abTestConfig),
// so a large cancelled backlog carrying archived HTML can't push the result
// toward Convex's function-result cap.
type AttentionCandidate = Pick<
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
// all-members: org-wide, same visibility as the campaign list, and behind the
// same `campaigns` floor (its builder) as the sibling `campaigns.campaigns.list`
// that serves the same surface's browse pills.
export const listAttentionCandidates = campaignsQuery({
	args: {},
	handler: async (ctx) => {
		const out: AttentionCandidate[] = [];
		const cancelledSince = Date.now() - CANCELLED_ATTENTION_WINDOW_MS;
		for (const status of ATTENTION_CANDIDATE_STATUSES) {
			const batch =
				status === 'cancelled'
					? await ctx.db
							.query('campaigns')
							.withIndex('by_status_and_updated_at', (q) =>
								q.eq('status', status).gte('updatedAt', cancelledSince)
							)
							.order('desc')
							.take(ATTENTION_CANDIDATE_CAP)
					: await ctx.db
							.query('campaigns')
							.withIndex('by_status', (q) => q.eq('status', status))
							.take(ATTENTION_CANDIDATE_CAP);
			out.push(...batch.map(projectCandidate));
		}
		return out;
	},
});

// Audience recipient counts moved to the Audience resolution (module) at
// `campaigns/audienceResolution.ts:countRecipients` (ADR-0033) — it runs the
// identical eligibility predicate as the send path, so the count can no longer
// over-report. The wizard calls `countRecipients({ audience })` directly.
