import type { MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';

/**
 * Fire-and-forget helper for tracking events from mutations.
 * Schedules an internal action that sends the event to PostHog.
 *
 * Usage:
 *   await trackEvent(ctx, session, 'campaign_sent', { recipientCount: 42 });
 */
export async function trackEvent(
	ctx: MutationCtx,
	session: { userId: string },
	event: string,
	properties?: Record<string, string | number>,
) {
	await ctx.scheduler.runAfter(0, internal.lib.posthog.capture, {
		distinctId: session.userId,
		event,
		properties: { ...properties },
	});
}
