/**
 * The daily re-verification sweep over sending domains. Pages through
 * `domains` and schedules one `reverification.reverifyDomain` per domain that
 * was ever verified, so each run stays bounded however many domains there are.
 * Domains never verified are left out: their operator is still publishing
 * records, and the Domains page re-checks them while it is open.
 *
 * The first page also schedules the tracking domains' re-check
 * (`trackingDomains.scheduleTrackingDomainRechecks`): a tracking domain whose
 * CNAME, proxy or certificate went away breaks every link in new mail, so it
 * is re-checked on the same cadence and with the same confirming check.
 */

import { v } from 'convex/values';
import { internal } from '../_generated/api';
import { internalMutation } from '../lib/writeFence';
import { scheduleTrackingDomainRechecks } from './trackingDomains';

const PAGE_SIZE = 100;
// Spread the checks so one sweep does not fire a burst of DNS lookups.
const STAGGER_MS = 1_000;

export const scheduleReverification = internalMutation({
	args: { cursor: v.optional(v.string()) },
	handler: async (ctx, args): Promise<number> => {
		const page = await ctx.db
			.query('domains')
			.paginate({ cursor: args.cursor ?? null, numItems: PAGE_SIZE });
		let scheduled = 0;
		for (const domain of page.page) {
			if (domain.verifiedAt === undefined || domain.status === 'registering') continue;
			await ctx.scheduler.runAfter(
				scheduled * STAGGER_MS,
				internal.domains.reverification.reverifyDomain,
				{ domainId: domain._id }
			);
			scheduled += 1;
		}
		if (args.cursor === undefined) {
			await scheduleTrackingDomainRechecks(ctx, STAGGER_MS);
		}
		if (!page.isDone) {
			await ctx.scheduler.runAfter(
				Math.max(scheduled * STAGGER_MS, STAGGER_MS),
				internal.domains.reverificationSweep.scheduleReverification,
				{ cursor: page.continueCursor }
			);
		}
		return scheduled;
	},
});
