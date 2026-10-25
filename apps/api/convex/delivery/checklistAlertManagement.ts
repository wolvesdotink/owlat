import { v } from 'convex/values';
import { adminMutation } from '../lib/authedFunctions';
import type { MutationSessionContext } from '../lib/sessionOrganization';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { resolveDeliverabilityAlert } from './checklistAlertResolution';

// The `adminMutation` floor has already required `organization:manage`; the
// org comparison keeps an alert id from another tenant reading as missing.
async function activeAlert(
	ctx: MutationCtx,
	session: MutationSessionContext,
	alertId: Id<'deliverabilityRegressionAlerts'>
) {
	const alert = await ctx.db.get(alertId);
	if (!alert || alert.organizationId !== session.activeOrganizationId) {
		throw new Error('Deliverability alert not found');
	}
	return alert;
}

export const acknowledge = adminMutation({
	args: { alertId: v.id('deliverabilityRegressionAlerts') },
	handler: async (ctx, args, session) => {
		const alert = await activeAlert(ctx, session, args.alertId);
		if (!alert.acknowledgedAt) {
			await ctx.db.patch(alert._id, { acknowledgedAt: Date.now() });
		}
		return true;
	},
});

export const resolve = adminMutation({
	args: { alertId: v.id('deliverabilityRegressionAlerts') },
	handler: async (ctx, args, session) => {
		const alert = await activeAlert(ctx, session, args.alertId);
		const now = Date.now();
		await resolveDeliverabilityAlert(ctx, alert, now, { acknowledge: true });
		return true;
	},
});
