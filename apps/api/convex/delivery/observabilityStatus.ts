import { adminQuery } from '../lib/authedFunctions';
import { requireOrgPermission } from '../lib/sessionOrganization';
import { loadSeedAccounts } from '../analytics/seedAccounts';
import { getOptional } from '../lib/env';
import { parseSndsFeedUrls } from './sndsConfig';

/** Admin-safe status only: no mailbox credentials or SNDS capability URLs leave the backend. */
export const get = adminQuery({
	args: {},
	handler: async (ctx) => {
		const session = await requireOrgPermission(ctx, 'organization:manage');
		const [seedAccounts, latestSnds] = await Promise.all([
			loadSeedAccounts(ctx.db, session.activeOrganizationId, Date.now()),
			ctx.db.query('sndsIpDailyStats').withIndex('by_period').order('desc').first(),
		]);
		const sndsFeeds = parseSndsFeedUrls(getOptional('SNDS_DATA_FEED_URLS'));
		return {
			seedMailboxes: {
				connected: seedAccounts.length,
				rotationRemindersDue: seedAccounts.filter((account) => account.rotationReminderDue).length,
			},
			microsoftFeedback: {
				configured: sndsFeeds.length > 0,
				feedCount: sndsFeeds.length,
				lastObservedAt: latestSnds?.fetchedAt,
			},
		};
	},
});
