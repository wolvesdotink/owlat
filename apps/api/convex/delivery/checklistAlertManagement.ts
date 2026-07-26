import { v } from 'convex/values';
import { adminMutation } from '../lib/authedFunctions';
import { requireOrgPermission } from '../lib/sessionOrganization';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';

async function activeAlert(ctx: MutationCtx, alertId: Id<'deliverabilityRegressionAlerts'>) {
	const session = await requireOrgPermission(ctx, 'organization:manage');
	const alert = await ctx.db.get(alertId);
	if (!alert || alert.organizationId !== session.activeOrganizationId) {
		throw new Error('Deliverability alert not found');
	}
	return alert;
}

export const acknowledge = adminMutation({
	args: { alertId: v.id('deliverabilityRegressionAlerts') },
	handler: async (ctx, args) => {
		const alert = await activeAlert(ctx, args.alertId);
		if (!alert.acknowledgedAt) {
			await ctx.db.patch(alert._id, { acknowledgedAt: Date.now() });
		}
		return true;
	},
});

export const resolve = adminMutation({
	args: { alertId: v.id('deliverabilityRegressionAlerts') },
	handler: async (ctx, args) => {
		const alert = await activeAlert(ctx, args.alertId);
		const now = Date.now();
		await ctx.db.patch(alert._id, {
			acknowledgedAt: alert.acknowledgedAt ?? now,
			resolvedAt: now,
		});
		return true;
	},
});
