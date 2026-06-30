/**
 * One-shot cleanup of the legacy chat scaffold.
 *
 * The previous implementation reused `conversationThreads` with
 * `contactIdentifier in {'internal-chat', 'channel'}` and stored chat messages in
 * `unifiedMessages` with `channel='chat'`. The new chat module owns dedicated
 * tables (`chatRooms`/`chatMessages`/…) so those leftover rows are now
 * unreachable garbage. This mutation deletes them.
 *
 * Idempotent. Safe on fresh deployments (no-op when nothing matches).
 *
 * Authorization: org-level admin only.
 *
 * The `'chat'` literal remains on `unifiedMessages.channel` and
 * `channelConfigs.channel` because narrowing a `v.union` is a deploy-time
 * break against any row that may still hold the old value (cf.
 * CONVENTIONS.md "Schema evolution"). The literal can be removed in a
 * follow-up PR once every deployment has run this cleanup.
 */

import { v } from 'convex/values';
import { authedMutation } from '../lib/authedFunctions';
import { requireAdminContext } from '../lib/sessionOrganization';

export const cleanupLegacyChatData = authedMutation({
	args: { dryRun: v.optional(v.boolean()) },
	handler: async (ctx, args) => {
		await requireAdminContext(ctx, 'Only owners and admins can run cleanup');

		const dryRun = args.dryRun ?? false;

		// Legacy threads: scoped via the `by_contact_identifier` index in two passes.
		const legacyInternalChat = await ctx.db
			.query('conversationThreads')
			.withIndex('by_contact_identifier', (q) => q.eq('contactIdentifier', 'internal-chat'))
			.collect(); // bounded: legacy chat-scaffold rows (admin one-shot cleanup)
		const legacyChannelThreads = await ctx.db
			.query('conversationThreads')
			.withIndex('by_contact_identifier', (q) => q.eq('contactIdentifier', 'channel'))
			.collect(); // bounded: legacy chat-scaffold rows (admin one-shot cleanup)
		const legacyThreads = [...legacyInternalChat, ...legacyChannelThreads];

		// Legacy chat messages: `channel='chat'` on unifiedMessages.
		const legacyMessages = await ctx.db
			.query('unifiedMessages')
			.withIndex('by_channel', (q) => q.eq('channel', 'chat'))
			.collect(); // bounded: legacy chat-scaffold rows (admin one-shot cleanup)

		const summary = {
			threadsToDelete: legacyThreads.length,
			messagesToDelete: legacyMessages.length,
			dryRun,
		};
		if (dryRun) return summary;

		for (const message of legacyMessages) {
			await ctx.db.delete(message._id);
		}
		for (const thread of legacyThreads) {
			// Also drop any unifiedMessages that referenced this thread under a
			// non-chat channel — they would otherwise dangle.
			const orphaned = await ctx.db
				.query('unifiedMessages')
				.withIndex('by_thread', (q) => q.eq('threadId', thread._id))
				.collect(); // bounded: messages of a single legacy thread (admin one-shot cleanup)
			for (const o of orphaned) {
				await ctx.db.delete(o._id);
			}
			await ctx.db.delete(thread._id);
		}

		return summary;
	},
});
