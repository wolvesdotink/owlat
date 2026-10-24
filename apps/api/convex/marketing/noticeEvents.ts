/**
 * The producer side of marketing notifications: what the campaign lifecycle,
 * campaign scheduling, the delivery snapshot, the automation sweep and breaker,
 * and the deliverability evidence writer call from inside their own mutations
 * to say "this occurrence may be worth telling people about".
 *
 * Deliberately one scheduler call: who hears about it, in which words, and
 * whether it still holds are decided later by the fan-out
 * (`marketing/notifications.fanOut`), outside the producer's transaction, so a
 * notification problem can never fail a send, a schedule or a sweep.
 *
 * Not a Convex function module; imported by the producers only.
 */

import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import type { MarketingNoticeEvent } from '../lib/validators/marketingNotifications';

/** How far ahead of its start a scheduled campaign reminds people. */
export const CAMPAIGN_REMINDER_LEAD_MS = 15 * 60 * 1000;

/**
 * How long after a campaign reaches `sent` its "finished" notice is written.
 * Completion means the last message left the queue, not that receivers have
 * answered: the delivered share is read after this pause, once most delivery
 * reports are in.
 */
export const CAMPAIGN_FINISHED_SETTLE_MS = 5 * 60 * 1000;

/** Hand one occurrence to the fan-out, now or after `delayMs`. */
export async function scheduleMarketingNotice(
	ctx: MutationCtx,
	event: MarketingNoticeEvent,
	delayMs = 0
): Promise<void> {
	await ctx.scheduler.runAfter(Math.max(0, delayMs), internal.marketing.notifications.fanOut, {
		event,
	});
}

/**
 * How long from `now` until the "sends in 15 minutes" reminder for a start at
 * `scheduledAt`, or null when the start is closer than the lead: whoever put
 * the campaign on the clock is looking at it right now. A start that moves
 * later makes a queued reminder stale; the fan-out re-checks it.
 */
export function campaignReminderDelayMs(scheduledAt: number, now: number): number | null {
	const delayMs = scheduledAt - CAMPAIGN_REMINDER_LEAD_MS - now;
	return delayMs > 0 ? delayMs : null;
}

/** Queue the reminder for a campaign just put on the clock for `scheduledAt`. */
export async function scheduleCampaignReminder(
	ctx: MutationCtx,
	campaignId: Id<'campaigns'>,
	scheduledAt: number,
	now: number
): Promise<void> {
	const delayMs = campaignReminderDelayMs(scheduledAt, now);
	if (delayMs === null) return;
	await scheduleMarketingNotice(
		ctx,
		{ kind: 'campaign_reminder', campaignId, scheduledAt },
		delayMs
	);
}
