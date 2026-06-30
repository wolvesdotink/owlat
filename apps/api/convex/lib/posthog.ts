'use node';

import { PostHog } from 'posthog-node';
import { internalAction } from '../_generated/server';
import { v } from 'convex/values';
import { getOptional } from './env';

/**
 * Internal action that sends an event to PostHog.
 * Called via ctx.scheduler.runAfter(0, ...) from mutations.
 */
export const capture = internalAction({
	args: {
		distinctId: v.string(),
		event: v.string(),
		properties: v.optional(v.record(v.string(), v.union(v.string(), v.number()))),
		groups: v.optional(v.record(v.string(), v.union(v.string(), v.number()))),
	},
	handler: async (_ctx, args) => {
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
