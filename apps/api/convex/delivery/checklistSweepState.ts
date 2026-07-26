import { v } from 'convex/values';
import { paginationOptsValidator } from 'convex/server';
import { DELIVERABILITY_CHECKLIST, type DeliverabilityCheckId } from '@owlat/shared';
import { internal } from '../_generated/api';
import { internalMutation } from '../_generated/server';
import { getSingletonOrganizationId } from '../lib/sessionOrganization';

const DOMAIN_BATCH_SIZE = 5;
export const HOURLY_DEPLOYMENT_CHECKS = new Set<DeliverabilityCheckId>([
	'deployment.ptr',
	'deployment.fcrdns',
	'deployment.ptr_nongeneric',
	'deployment.ehlo_ptr',
	'deployment.dnsbl',
	'deployment.ipv6_ptr',
	'deployment.ipv6_aaaa',
]);

export const schedulePage = internalMutation({
	args: {
		mode: v.union(v.literal('daily'), v.literal('hourly')),
		paginationOpts: paginationOptsValidator,
	},
	handler: async (ctx, args): Promise<{ done: boolean }> => {
		const organizationId = await getSingletonOrganizationId(ctx);
		const isFirstPage = args.paginationOpts.cursor === null;
		if (isFirstPage) {
			const deploymentChecks = DELIVERABILITY_CHECKLIST.filter(
				(item) =>
					item.id.startsWith('deployment.') &&
					(args.mode === 'daily' || HOURLY_DEPLOYMENT_CHECKS.has(item.id))
			);
			for (const item of deploymentChecks) {
				await ctx.scheduler.runAfter(0, internal.delivery.checklistVerification.sweep, {
					organizationId,
					itemId: item.id,
				});
			}
		}
		if (args.mode === 'hourly') return { done: true as const };

		const page = await ctx.db.query('domains').paginate({
			cursor: args.paginationOpts.cursor,
			numItems: DOMAIN_BATCH_SIZE,
		});
		const domainChecks = DELIVERABILITY_CHECKLIST.filter((item) => item.id.startsWith('domain.'));
		for (const domain of page.page) {
			for (const item of domainChecks) {
				await ctx.scheduler.runAfter(0, internal.delivery.checklistVerification.sweep, {
					organizationId,
					itemId: item.id,
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
