/**
 * The writes a push leaves on a device row: a notification quiet hours held
 * back, and what the push service answered. Shared by the commits in
 * `push/dispatch.ts` and `push/delivery.ts`.
 */

import { v, type Infer } from 'convex/values';
import {
	localClockIn,
	minutesUntilQuietEnd,
	type QuietHours,
} from '@owlat/shared/notificationRules';
import type { Doc } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';

export const pushOutcomeValidator = v.object({
	subscriptionId: v.id('pushSubscriptions'),
	outcome: v.union(
		v.literal('delivered'),
		v.literal('gone'),
		v.literal('rejected'),
		v.literal('failed')
	),
});

/**
 * Count one held-back notification on a device and make sure its summary is
 * scheduled for the moment the window ends there. Marketing notices are
 * counted apart: the summary applies "Notify me about" to held mail only.
 */
export async function deferForQuietHours(
	ctx: MutationCtx,
	subscription: Doc<'pushSubscriptions'>,
	quietHours: QuietHours,
	now: number,
	isMarketing = false
): Promise<void> {
	const patch: Partial<Doc<'pushSubscriptions'>> = isMarketing
		? { quietDeferredMarketingCount: (subscription.quietDeferredMarketingCount ?? 0) + 1 }
		: { quietDeferredCount: (subscription.quietDeferredCount ?? 0) + 1 };
	if (subscription.quietSummaryAt === undefined) {
		const minutes = minutesUntilQuietEnd(quietHours, localClockIn(subscription.timeZone, now));
		const at = now + (minutes ?? 1) * 60_000;
		patch.quietSummaryAt = at;
		await ctx.scheduler.runAt(at, internal.push.send.deliverQuietSummary, {
			subscriptionId: subscription._id,
		});
	}
	await ctx.db.patch(subscription._id, patch);
}

/**
 * Write back what the push services said: stamp `lastSuccessAt` on accepted
 * devices and delete the ones that answered 404/410 — the browser dropped that
 * subscription, and it will never accept a message again.
 */
export async function applyPushOutcomes(
	ctx: MutationCtx,
	outcomes: Infer<typeof pushOutcomeValidator>[]
): Promise<void> {
	const now = Date.now();
	for (const { subscriptionId, outcome } of outcomes) {
		const subscription = await ctx.db.get(subscriptionId);
		if (!subscription) continue;
		if (outcome === 'gone') await ctx.db.delete(subscriptionId);
		else if (outcome === 'delivered') await ctx.db.patch(subscriptionId, { lastSuccessAt: now });
	}
}
