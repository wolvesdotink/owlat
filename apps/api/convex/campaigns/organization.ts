import { authedQuery } from '../lib/authedFunctions';
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
