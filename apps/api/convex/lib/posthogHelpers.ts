import type { MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { isFeatureEnabled } from './featureFlags';

/**
 * Fire-and-forget helper for tracking events from mutations.
 * Schedules an internal action that sends the event to PostHog.
 *
 * Every backend event goes through here, so this is also where
 * `analytics.posthog` is honoured on the write path: with the flag off nothing
 * is even scheduled, which keeps an instance that never enabled analytics from
 * paying for a scheduled function per contact, campaign and automation it
 * creates. `lib/posthog.capture` re-checks the flag when it runs — see the
 * rationale there.
 *
 * Usage:
 *   await trackEvent(ctx, session, 'campaign_sent', { recipientCount: 42 });
 */
export async function trackEvent(
	ctx: MutationCtx,
	session: { userId: string },
	event: string,
	properties?: Record<string, string | number>
) {
	if (!(await isFeatureEnabled(ctx, 'analytics.posthog'))) return;

	await ctx.scheduler.runAfter(0, internal.lib.posthog.capture, {
		distinctId: session.userId,
		event,
		properties: { ...properties },
	});
}
