import { v } from 'convex/values';
import { paginationOptsValidator } from 'convex/server';
import { HOURLY_DELIVERABILITY_CHECK_IDS, type DeliverabilityCheckId } from '@owlat/shared';
import { internal } from '../_generated/api';
import { internalMutation } from '../_generated/server';
import { getSingletonOrganizationId } from '../lib/sessionOrganization';
import { DEPLOYMENT_CHECK_IDS, DOMAIN_CHECK_IDS } from './checklistTraits';

const DOMAIN_BATCH_SIZE = 5;
export const HOURLY_DEPLOYMENT_CHECKS = new Set<DeliverabilityCheckId>(
	HOURLY_DELIVERABILITY_CHECK_IDS
);

export const schedulePage = internalMutation({
	args: {
		mode: v.union(v.literal('daily'), v.literal('hourly')),
		paginationOpts: paginationOptsValidator,
	},
	handler: async (ctx, args): Promise<{ done: boolean }> => {
		const organizationId = await getSingletonOrganizationId(ctx);
		const isFirstPage = args.paginationOpts.cursor === null;
		if (isFirstPage) {
			const deploymentChecks = DEPLOYMENT_CHECK_IDS.filter(
				(itemId) => args.mode === 'daily' || HOURLY_DEPLOYMENT_CHECKS.has(itemId)
			);
			for (const itemId of deploymentChecks) {
				await ctx.scheduler.runAfter(0, internal.delivery.checklistVerification.sweep, {
					organizationId,
					itemId,
				});
			}
		}
		if (args.mode === 'hourly') return { done: true as const };

		const page = await ctx.db.query('domains').paginate({
			cursor: args.paginationOpts.cursor,
			numItems: DOMAIN_BATCH_SIZE,
		});
		for (const domain of page.page) {
			for (const itemId of DOMAIN_CHECK_IDS) {
				await ctx.scheduler.runAfter(0, internal.delivery.checklistVerification.sweep, {
					organizationId,
					itemId,
					domainId: domain._id,
				});
			}
		}
		if (!page.isDone) {
			await ctx.scheduler.runAfter(500, internal.delivery.checklistSweep.continueDaily, {
				cursor: page.continueCursor,
			});
		}
		return { done: page.isDone };
	},
});
