import { adminQuery } from '../lib/authedFunctions';
import { loadSeedAccounts } from '../analytics/seedAccounts';
import { getOptional } from '../lib/env';
import { parseSndsFeedUrls } from './sndsConfig';

/** Admin-safe status only: no mailbox credentials or SNDS capability URLs leave the backend. */
export const get = adminQuery({
	args: {},
	handler: async (ctx, _args, session) => {
		// The `adminQuery` floor has ALREADY run
		// `requireOrgPermission(ctx, 'organization:manage')` — the session, the
		// active org and the admin role are all decided before this handler runs,
		// and the floor threads its result in as `session`. So the org id this read
		// is scoped by costs NOTHING: no second session read, no second `member`
		// component query, and no way for the scope to disagree with the identity
		// the floor admitted. That matters here because the admin delivery hub
		// live-subscribes this query and every seed-account / `sndsIpDailyStats`
		// write re-runs it.
		const organizationId = session.activeOrganizationId;
		const [seedAccounts, latestSnds] = await Promise.all([
			loadSeedAccounts(ctx.db, organizationId, Date.now()),
			ctx.db.query('sndsIpDailyStats').withIndex('by_period').order('desc').first(),
		]);
		const sndsFeeds = parseSndsFeedUrls(getOptional('SNDS_DATA_FEED_URLS'));
		return {
			seedMailboxes: {
				connected: seedAccounts.length,
				rotationRemindersDue: seedAccounts.filter((account) => account.rotationReminderDue).length,
				accounts: seedAccounts,
			},
			microsoftFeedback: {
				configured: sndsFeeds.length > 0,
				feedCount: sndsFeeds.length,
				lastObservedAt: latestSnds?.fetchedAt,
			},
		};
	},
});
