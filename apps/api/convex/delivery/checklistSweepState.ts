import { v } from 'convex/values';
import { paginationOptsValidator } from 'convex/server';
import { HOURLY_DELIVERABILITY_CHECK_IDS, type DeliverabilityCheckId } from '@owlat/shared';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { internalMutation } from '../lib/writeFence';
import { getSingletonOrganizationId } from '../lib/sessionOrganization';
import { DEPLOYMENT_CHECK_IDS, DOMAIN_CHECK_IDS } from './checklistTraits';
import { deliverabilityTargetKey } from './checklistEvidence';
import {
	isChecklistItemApplicable,
	loadDeliverabilitySendPaths,
	retireInapplicableCheck,
} from './checklistApplicability';

const DOMAIN_BATCH_SIZE = 5;
const HOURLY_DEPLOYMENT_CHECKS = new Set<DeliverabilityCheckId>(HOURLY_DELIVERABILITY_CHECK_IDS);

export const schedulePage = internalMutation({
	args: {
		mode: v.union(v.literal('daily'), v.literal('hourly')),
		paginationOpts: paginationOptsValidator,
	},
	handler: async (ctx, args): Promise<{ done: boolean }> => {
		const organizationId = await getSingletonOrganizationId(ctx);
		const sendPaths = await loadDeliverabilitySendPaths(ctx);
		const now = Date.now();
		// A check that does not apply is not run, and one that stopped applying
		// gives up its evidence and open alerts here.
		const sweepOrRetire = async (itemId: DeliverabilityCheckId, domainId?: Id<'domains'>) => {
			if (isChecklistItemApplicable(itemId, sendPaths)) {
				await ctx.scheduler.runAfter(0, internal.delivery.checklistVerification.sweep, {
					organizationId,
					itemId,
					...(domainId ? { domainId } : {}),
				});
				return;
			}
			await retireInapplicableCheck(ctx, {
				organizationId,
				targetKey: deliverabilityTargetKey(organizationId, domainId),
				itemId,
				now,
			});
		};
		const isFirstPage = args.paginationOpts.cursor === null;
		if (isFirstPage) {
			const deploymentChecks = DEPLOYMENT_CHECK_IDS.filter(
				(itemId) => args.mode === 'daily' || HOURLY_DEPLOYMENT_CHECKS.has(itemId)
			);
			for (const itemId of deploymentChecks) await sweepOrRetire(itemId);
		}
		if (args.mode === 'hourly') return { done: true as const };

		const page = await ctx.db.query('domains').paginate({
			cursor: args.paginationOpts.cursor,
			numItems: DOMAIN_BATCH_SIZE,
		});
		for (const domain of page.page) {
			for (const itemId of DOMAIN_CHECK_IDS) await sweepOrRetire(itemId, domain._id);
		}
		if (!page.isDone) {
			await ctx.scheduler.runAfter(500, internal.delivery.checklistSweep.continueDaily, {
				cursor: page.continueCursor,
			});
		}
		return { done: page.isDone };
	},
});
