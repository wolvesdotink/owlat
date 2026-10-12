/**
 * The scheduled continuation of a sender-memory invalidation
 * (`./senderMemory.ts invalidateSenderMemory`): one more page per run, until
 * every entry of the sender in the scope is invalidated.
 */

import { v } from 'convex/values';
import { internalMutation } from '../lib/writeFence';
import { senderMemoryScopeValidator } from '../lib/validators/aiRouting';
import { invalidateSenderMemory } from './senderMemory';

export const invalidateRest = internalMutation({
	args: {
		scope: senderMemoryScopeValidator,
		mailboxId: v.optional(v.id('mailboxes')),
		senderDigest: v.string(),
		reason: v.union(v.literal('owner_correction'), v.literal('auth_failure')),
		at: v.number(),
		cursor: v.string(),
	},
	handler: async (ctx, args) => {
		const { reason, at, cursor, ...key } = args;
		await invalidateSenderMemory(ctx, key, reason, at, cursor);
	},
});
