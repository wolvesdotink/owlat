/**
 * The team-inbox half of Answer mode's catch-up cache (the Postbox half and the
 * shared writer live in mail/ai/catchUpStore.ts). Non-'use node', so the
 * reactive read and the actions' pre-check can run as queries.
 *
 * A team thread's count, for staleness, is its inbound messages plus the
 * replies the team sent ({@link teamCatchUpMessageCount}): a sent reply lives
 * on the inbound row it answers and can close an ask, so it has to invalidate
 * the card even though `conversationThreads.messageCount` does not move.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import { internalQuery, type QueryCtx } from '../_generated/server';
import { publicQuery } from '../lib/authedFunctions';
import { isFeatureEnabled } from '../lib/featureFlags';
import { getBetterAuthSessionWithRole } from '../lib/sessionOrganization';
import {
	normalizeCatchUpLocale,
	teamCatchUpMessageCount,
	visibleCatchUp,
	type CatchUp,
} from '../mail/ai/catchUpPrompt';
import { isSharedInboxReader } from './access';

/** The cached row and the live count, when the caller reads the shared inbox. */
async function readTeamCatchUp(
	ctx: QueryCtx,
	threadId: Id<'conversationThreads'>,
	locale: string
): Promise<{ messageCount: number; row: Doc<'threadCatchUps'> | null } | null> {
	const session = await getBetterAuthSessionWithRole(ctx);
	if (!isSharedInboxReader(session)) return null;
	const thread = await ctx.db.get(threadId);
	if (!thread) return null;
	const [messages, row] = await Promise.all([
		ctx.db
			.query('inboundMessages')
			.withIndex('by_thread', (q) => q.eq('threadId', threadId))
			.collect(), // bounded: one thread's inbound messages (as inbox.queries.getThread)
		ctx.db
			.query('threadCatchUps')
			.withIndex('by_conversation_thread_and_locale', (q) =>
				q.eq('conversationThreadId', threadId).eq('locale', locale)
			)
			.first(),
	]);
	return { messageCount: teamCatchUpMessageCount(messages), row };
}

// public: soft-auth — admin-only shared inbox; returns null for a caller who is
// not a shared-inbox reader (isSharedInboxReader), when the `ai` flag is off, or
// when the cached card is missing or stale.
export const get = publicQuery({
	args: { threadId: v.id('conversationThreads'), locale: v.string() },
	handler: async (ctx, args): Promise<CatchUp | null> => {
		const state = await readTeamCatchUp(ctx, args.threadId, normalizeCatchUpLocale(args.locale));
		if (!state?.row || state.row.messageCount !== state.messageCount) return null;
		if (!(await isFeatureEnabled(ctx, 'ai'))) return null;
		return visibleCatchUp(state.row);
	},
});

/**
 * The pre-check for inbox/catchUp.ts, under the calling user's auth: null for a
 * non-reader, otherwise the live count, the AI flag and the row when fresh.
 */
export const readForThread = internalQuery({
	args: { threadId: v.id('conversationThreads'), locale: v.string() },
	handler: async (ctx, args) => {
		const state = await readTeamCatchUp(ctx, args.threadId, args.locale);
		if (!state) return null;
		const { messageCount, row } = state;
		return {
			messageCount,
			aiEnabled: await isFeatureEnabled(ctx, 'ai'),
			cached: row && row.messageCount === messageCount ? row : null,
		};
	},
});
