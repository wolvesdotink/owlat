/**
 * The demo stack's sending switch: suspend sending on the instance for a
 * capture of the suspended state, and lift it again. Driven by
 * `POST /seed/demo/sending` (`seedDemo/indexHttp.ts`), DEV deployments only.
 *
 * It is not a seed fixture on purpose: a suspended instance refuses every send,
 * so a seed that left it on would put the suspension banner and refusals into
 * every other capture. The switch goes through the platform admin's path
 * (`workspaces/abuseStatus.adminOverride`), so the audit entry, the owner
 * notices and the deliverability alert channels see the same change a real
 * suspension makes, and lifting it is the platform admin's lift.
 */

import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';

/** The reason the suspension carries, shown wherever the app names it. */
export const DEMO_SUSPENSION_REASON = 'Demo: sending suspended for a capture';

const CHANGED_BY = 'dev-seed';

export interface DemoSendingState {
	abuseStatus: 'clean' | 'warned' | 'suspended' | 'banned';
	reason: string | null;
	changedAt: number | null;
}

export const getDemoSendingState = internalQuery({
	args: {},
	handler: async (ctx): Promise<DemoSendingState | null> => {
		const settings = await ctx.db.query('instanceSettings').first();
		if (!settings) return null;
		return {
			abuseStatus: settings.abuseStatus ?? 'clean',
			reason: settings.abuseStatusReason ?? null,
			changedAt: settings.abuseStatusChangedAt ?? null,
		};
	},
});

export const setDemoSendingSuspended = internalMutation({
	args: { suspended: v.boolean() },
	handler: async (ctx, { suspended }): Promise<DemoSendingState | null> => {
		const outcome = await ctx.runMutation(internal.workspaces.abuseStatus.adminOverride, {
			input: {
				to: suspended ? 'suspended' : 'clean',
				at: Date.now(),
				reason: suspended ? DEMO_SUSPENSION_REASON : 'Demo: sending allowed again',
				changedBy: CHANGED_BY,
			},
		});
		if (!outcome.ok) return null;
		return await ctx.runQuery(internal.seedDemo.sendingState.getDemoSendingState, {});
	},
});
