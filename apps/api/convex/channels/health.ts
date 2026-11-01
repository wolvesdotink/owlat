/**
 * Channel health: the cron that checks every enabled channel, and the commit
 * of a single channel's probe (`outbound.ts` `probeChannelHealth`).
 */

import { v, type ObjectType } from 'convex/values';
import type { FunctionArgs } from 'convex/server';
import {
	internalQuery,
	internalAction,
	type ActionCtx,
	type MutationCtx,
	type QueryCtx,
} from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { unifiedMessageChannelValidator } from '../lib/convexValidators';
import { healthStatusValidator } from '../lib/literalValidators';

/** A channel's health as a check found it. */
export const channelHealthFields = {
	healthStatus: healthStatusValidator,
	lastError: v.optional(v.string()),
};

/**
 * Stamp a health check's result on a channel's config row. An absent
 * `lastError` keeps the last one recorded.
 */
export async function writeChannelHealth(
	ctx: MutationCtx,
	configId: Id<'channelConfigs'>,
	health: ObjectType<typeof channelHealthFields>
): Promise<void> {
	const now = Date.now();
	await ctx.db.patch(configId, {
		healthStatus: health.healthStatus,
		lastHealthCheckAt: now,
		...(health.lastError !== undefined ? { lastError: health.lastError } : {}),
		updatedAt: now,
	});
}

/** The commit of `channels/outbound.probeChannelHealth`. */
export const updateChannelHealthArgs = {
	channel: unifiedMessageChannelValidator,
	...channelHealthFields,
};

export async function recordChannelHealth(
	ctx: MutationCtx,
	{ channel, ...health }: ObjectType<typeof updateChannelHealthArgs>
): Promise<void> {
	const config = await ctx.db
		.query('channelConfigs')
		.withIndex('by_channel', (q) => q.eq('channel', channel))
		.first();

	if (!config) return;
	await writeChannelHealth(ctx, config._id, health);
}

export const updateChannelHealth = internalMutation({
	args: updateChannelHealthArgs,
	handler: async (ctx, args) => await recordChannelHealth(ctx, args),
});

/**
 * Run health checks on all enabled channels. A configured SMS/WhatsApp/webhook
 * channel is probed by `channels/outbound.probeChannelHealth`, which records
 * its own result; every other result lands in one commit at the end.
 */
export async function checkEnabledChannels(ctx: ActionCtx): Promise<null> {
	const configs = await ctx.runQuery(internal.channels.health.getEnabledChannels);
	const results: ChannelHealthResult[] = [];

	for (const config of configs) {
		const checked = { channel: config.channel, hadCredentials: Boolean(config.config) };
		// Email/chat have no outbound provider adapter here (email health
		// is tracked by the existing providerHealth system; chat is native),
		// so config-presence is the only available signal.
		if (config.channel === 'email' || config.channel === 'chat') {
			results.push({ ...checked, healthStatus: 'healthy' });
			continue;
		}

		// For SMS/WhatsApp/Webhook: fast-path the unconfigured case, then
		// run the adapter's REAL healthCheck() probe (Twilio/Meta/webhook)
		// for configured channels. The probe needs node:crypto to decrypt
		// the stored creds, so it lives in a `'use node'` action — a channel
		// with revoked/invalid credentials surfaces degraded/down instead of
		// reporting healthy off mere config-blob presence.
		if (!config.config) {
			results.push({
				...checked,
				healthStatus: 'down',
				lastError: 'No credentials configured',
			});
			continue;
		}

		try {
			await ctx.runAction(internal.channels.outbound.probeChannelHealth, {
				channel: config.channel,
			});
		} catch (error) {
			results.push({
				...checked,
				healthStatus: 'down',
				lastError: error instanceof Error ? error.message : String(error),
			});
		}
	}

	if (results.length > 0) {
		await ctx.runMutation(internal.channels.outboundCommit.recordHealthChecks, { results });
	}
	return null;
}

export const runChannelHealthChecks = internalAction({
	args: {},
	returns: v.null(),
	handler: async (ctx) => await checkEnabledChannels(ctx),
});

type ChannelHealthResult = FunctionArgs<
	typeof internal.channels.outboundCommit.recordHealthChecks
>['results'][number];

/**
 * Internal query to get enabled channel configs
 */
export async function enabledChannelConfigs(ctx: QueryCtx) {
	// `channelConfigs` is intrinsically tiny — one row per channel
	// kind (email/sms/whatsapp/generic/chat), capped by the union
	// literal in the schema. Indexing would add maintenance cost for
	// no read win at this scale.
	const all = await ctx.db.query('channelConfigs').collect(); // bounded: ≤5 rows by schema literal union
	return all.filter((c) => c.isEnabled);
}

export const getEnabledChannels = internalQuery({
	args: {},
	handler: async (ctx) => await enabledChannelConfigs(ctx),
});
