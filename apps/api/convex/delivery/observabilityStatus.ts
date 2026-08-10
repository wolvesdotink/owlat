import { adminQuery } from '../lib/authedFunctions';
import { getBetterAuthSession } from '../lib/sessionOrganization';
import { throwForbidden } from '../_utils/errors';
import { loadSeedAccounts } from '../analytics/seedAccounts';
import { getOptional } from '../lib/env';
import { parseSndsFeedUrls } from './sndsConfig';

/** Admin-safe status only: no mailbox credentials or SNDS capability URLs leave the backend. */
export const get = adminQuery({
	args: {},
	handler: async (ctx) => {
		// The `adminQuery` floor has ALREADY run
		// `requireOrgPermission(ctx, 'organization:manage')` — the session, the
		// active org and the admin role are all decided before this handler runs.
		// All it still needs is the org id to scope the seed read by, so it takes
		// the cheap path: `getBetterAuthSession` reads `activeOrganizationId`
		// straight off the JWT claims, where the floor's own lookup got it, instead
		// of paying a second session + `member` component query. That matters here
		// because the admin delivery hub live-subscribes this query and every
		// seed-account / `sndsIpDailyStats` write re-runs it.
		const session = await getBetterAuthSession(ctx);
		const organizationId = session?.activeOrganizationId;
		if (!organizationId) {
			// Unreachable behind the floor (same helper, same request, deterministic
			// within one query execution) — kept so the org scope can never be
			// silently dropped if the floor ever changes.
			throwForbidden('No active organization. Please select an organization.');
		}
		const [seedAccounts, latestSnds] = await Promise.all([
			loadSeedAccounts(ctx.db, organizationId, Date.now()),
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
