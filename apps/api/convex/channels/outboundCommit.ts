/**
 * The commits of the channel dispatch and the delivery-status poll
 * (`channels/outbound.ts`). That file is `'use node'`, so the mutations its
 * actions end with live here: each action reads, talks to the provider, then
 * writes what it learned in one of these. The channel health cron
 * (`health.ts` `runChannelHealthChecks`) commits here too.
 */

import { v } from 'convex/values';
import { internalMutation } from '../lib/writeFence';
import { unifiedMessageChannelValidator } from '../lib/convexValidators';
import { insertOutboundMessage } from './messages';
import { channelHealthFields, writeChannelHealth } from './health';
import { applyProcessingTransition } from '../inbox/processingLifecycle';

/**
 * What one dispatch ended with: the outbound timeline row (when a thread is
 * known) and, for an approved agent reply, the inbound message's `sent` or
 * `failed` step, in one transaction so the timeline and the reply's status
 * never disagree about whether it went out.
 */
export const recordDispatch = internalMutation({
	args: {
		channel: unifiedMessageChannelValidator,
		contactId: v.id('contacts'),
		threadId: v.optional(v.id('conversationThreads')),
		/** The dispatched content, JSON as the timeline row stores it. */
		content: v.string(),
		status: v.union(v.literal('sent'), v.literal('failed')),
		externalMessageId: v.optional(v.string()),
		error: v.optional(v.string()),
		inboundMessageId: v.optional(v.id('inboundMessages')),
	},
	handler: async (ctx, args): Promise<void> => {
		if (args.threadId) {
			await insertOutboundMessage(ctx, {
				threadId: args.threadId,
				channel: args.channel,
				contactId: args.contactId,
				content: args.content,
				externalMessageId: args.externalMessageId,
				status: args.status,
				...(args.error ? { metadata: JSON.stringify({ error: args.error }) } : {}),
			});
		}
		// Channels have no send-completion module (unlike the MTA email path), so
		// the approved reply is moved off the real send outcome here.
		if (args.inboundMessageId) {
			const at = Date.now();
			await applyProcessingTransition(
				ctx,
				args.inboundMessageId,
				args.status === 'sent'
					? { to: 'sent', at }
					: { to: 'failed', at, errorMessage: args.error ?? 'Channel dispatch failed' }
			);
		}
	},
});

/**
 * One poll's progressed statuses. A row is moved only while it is still
 * `sent`, the status the poll listed it under: one a webhook or an
 * overlapping poll already moved keeps its newer status, and a row erased
 * meanwhile is skipped.
 */
export const recordDeliveryStatuses = internalMutation({
	args: {
		updates: v.array(
			v.object({
				messageId: v.id('unifiedMessages'),
				status: v.union(v.literal('delivered'), v.literal('read'), v.literal('failed')),
			})
		),
	},
	handler: async (ctx, args): Promise<void> => {
		for (const update of args.updates) {
			const row = await ctx.db.get(update.messageId);
			if (row?.status !== 'sent') continue;
			await ctx.db.patch(update.messageId, { status: update.status });
		}
	},
});

/**
 * The health checks one cron run settled without a probe. A channel whose
 * config was removed, disabled, or had its credentials added or removed since
 * the run read it is skipped: the result describes a config it no longer has,
 * and the next run checks it again.
 */
export const recordHealthChecks = internalMutation({
	args: {
		results: v.array(
			v.object({
				channel: unifiedMessageChannelValidator,
				/** Whether the config the check read held credentials. */
				hadCredentials: v.boolean(),
				...channelHealthFields,
			})
		),
	},
	handler: async (ctx, args): Promise<void> => {
		for (const { channel, hadCredentials, ...health } of args.results) {
			const config = await ctx.db
				.query('channelConfigs')
				.withIndex('by_channel', (q) => q.eq('channel', channel))
				.first();
			if (!config?.isEnabled || Boolean(config.config) !== hadCredentials) continue;
			await writeChannelHealth(ctx, config._id, health);
		}
	},
});
