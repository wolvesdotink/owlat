/**
 * The commits of the channel dispatch and the delivery-status poll
 * (`channels/outbound.ts`). That file is `'use node'`, so the mutations its
 * actions end with live here: each action reads, talks to the provider, then
 * writes what it learned in one of these.
 */

import { v } from 'convex/values';
import { internalMutation } from '../lib/writeFence';
import { unifiedMessageChannelValidator } from '../lib/convexValidators';
import { insertOutboundMessage } from '../unifiedMessages';
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
