'use node';

import { PostHog } from 'posthog-node';
import { internalAction } from '../_generated/server';
import { internal } from '../_generated/api';
import { v } from 'convex/values';
import { getOptional } from './env';

/**
 * Internal action that sends an event to PostHog.
 * Called via ctx.scheduler.runAfter(0, ...) from mutations.
 *
 * `analytics.posthog` is re-checked here and not only by `trackEvent`, because
 * this is the one place in the backend where an event actually leaves the
 * instance. A scheduled action runs later than the mutation that queued it, so
 * an admin who turns the flag off still stops the events already in flight; and
 * a future caller that schedules this action directly cannot bypass the gate by
 * forgetting it.
 */
export const capture = internalAction({
	args: {
		distinctId: v.string(),
		event: v.string(),
		properties: v.optional(v.record(v.string(), v.union(v.string(), v.number()))),
		groups: v.optional(v.record(v.string(), v.union(v.string(), v.number()))),
	},
	handler: async (ctx, args) => {
		const flags = await ctx.runQuery(internal.workspaces.featureFlags.getResolvedFlags, {});
		if (flags['analytics.posthog'] !== true) return;

		const apiKey = getOptional('POSTHOG_API_KEY');
		const host = getOptional('POSTHOG_HOST') || 'https://eu.i.posthog.com';
		if (!apiKey) return;

		const client = new PostHog(apiKey, { host });
		client.capture({
			distinctId: args.distinctId,
			event: args.event,
			properties: args.properties,
			groups: args.groups,
		});
		await client.shutdown();
	},
});
