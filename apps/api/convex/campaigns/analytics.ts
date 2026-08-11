import type { Doc } from '../_generated/dataModel';
import { authedQuery } from '../lib/authedFunctions';

/** Safety cap on the comparable-send window (index-ordered take, no scan). */
const COMPARABLE_SENDS_LIMIT = 100;

// Recent sent campaigns as lightweight comparison snapshots — powers the
// "delta vs previous comparable send" line under each report hero tile. Returns
// only the aggregated `stats*` counts + `isABTest`/`sentAt` needed to pick the
// prior comparable send and diff its rates; the report page runs the pure
// selection (`selectPreviousComparable`) and delta math client-side so the
// choice is unit-testable without Convex. Bounded by the index-ordered take, so
// no `emailSends` are read here.
// all-members: aggregated campaign send stats for the comparison UI.
export const getComparableSentCampaigns = authedQuery({
	args: {},
	handler: async (ctx) => {
		const sentCampaigns = await ctx.db
			.query('campaigns')
			.withIndex('by_status_sent_at', (q) => q.eq('status', 'sent'))
			.order('desc')
			.take(COMPARABLE_SENDS_LIMIT);

		return sentCampaigns
			.filter((c): c is Doc<'campaigns'> & { sentAt: number } => c.sentAt !== undefined)
			.map((c) => ({
				id: c._id,
				name: c.name,
				sentAt: c.sentAt,
				isABTest: c.isABTest ?? false,
				sent: c.statsSent ?? 0,
				delivered: c.statsDelivered ?? 0,
				opened: c.statsOpened ?? 0,
				clicked: c.statsClicked ?? 0,
				bounced: c.statsBounced ?? 0,
			}));
	},
});
