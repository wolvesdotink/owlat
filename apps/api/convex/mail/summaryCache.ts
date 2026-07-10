/**
 * Cached-summary layer for the long-thread summary strip.
 *
 * The persisted summary lives in a small `summaryCache` field on the `mailThreads`
 * row (schema/mail.ts). This module is the non-'use node' half of the feature:
 *
 *   - {@link getThreadSummary} — reactive read the strip subscribes to, so a warm
 *     cache paints instantly (no action round-trip). It serves the cache ONLY
 *     while `summaryCache.messageCount` still matches the thread's live
 *     `messageCount`; a new inbound message bumps that count and the query flips
 *     to `null`, which is what triggers the strip to regenerate on next open.
 *   - {@link setThreadSummaryCache} — the sole writer, called by the 'use node'
 *     action mail/ai.ts `getOrGenerateThreadSummary` after a cheap-tier
 *     regeneration (the action can't hold a mutation, hence this split, mirroring
 *     mail/aiGate.ts).
 *
 * Everything here is advisory + fail-soft: the strip disappears entirely when the
 * cache is cold and generation is unavailable. This never moves or modifies mail.
 */

import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { publicQuery } from '../lib/authedFunctions';
import { loadReadableMailbox } from './permissions';

// public: soft-auth — returns null for anonymous; mailbox access is enforced
// in-handler via loadReadableMailbox (returns null for a non-member). The cache is
// served only while it matches the live messageCount, so a stale entry reads as
// null and the strip regenerates.
export const getThreadSummary = publicQuery({
	args: { messageId: v.id('mailMessages') },
	handler: async (ctx, args) => {
		const seed = await ctx.db.get(args.messageId);
		if (!seed) return null;
		const mailbox = await loadReadableMailbox(ctx, seed.mailboxId);
		if (!mailbox) return null;
		const thread = await ctx.db.get(seed.threadId);
		const cache = thread?.summaryCache;
		if (!cache) return null;
		// Serve only a fresh cache: a mismatch means a message was added/removed
		// since generation, so the summary is stale — return null so the reader
		// regenerates rather than showing an out-of-date summary.
		if (cache.messageCount !== thread.messageCount) return null;
		return {
			summary: cache.summary,
			messageCount: cache.messageCount,
			generatedAt: cache.generatedAt,
		};
	},
});

/**
 * Persist a freshly generated thread summary. Internal-only: the sole caller is
 * mail/ai.ts `getOrGenerateThreadSummary`, which has already enforced ownership
 * (via listThreadMessages) and the AI gate. Overwrites any previous cache.
 */
export const setThreadSummaryCache = internalMutation({
	args: {
		threadId: v.id('mailThreads'),
		summary: v.string(),
		messageCount: v.number(),
		generatedAt: v.number(),
	},
	handler: async (ctx, args) => {
		const thread = await ctx.db.get(args.threadId);
		if (!thread) return;
		await ctx.db.patch(args.threadId, {
			summaryCache: {
				summary: args.summary,
				messageCount: args.messageCount,
				generatedAt: args.generatedAt,
			},
		});
	},
});
