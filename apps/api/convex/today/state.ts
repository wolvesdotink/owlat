/**
 * Today's "since you last looked" watermark.
 *
 * The home screen reports what arrived and what moved since this point. It is
 * per user (a shared inbox has shared read flags, so those cannot say what
 * THIS person has already seen) and it only moves on purpose: the explicit
 * "Mark all as seen", finishing the Answer queue, or a deliberate dwell on
 * Today. Nothing here reads mail; it is a single timestamp per member.
 */

import { v } from 'convex/values';
import { authedMutation, authedQuery } from '../lib/authedFunctions';
import type { MutationCtx, QueryCtx } from '../_generated/server';

/** With no watermark yet, Today looks back this far. */
export const FIRST_VISIT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

async function loadState(ctx: QueryCtx | MutationCtx, userId: string, organizationId: string) {
	return ctx.db
		.query('todayStates')
		.withIndex('by_user_and_organization', (q) =>
			q.eq('userId', userId).eq('organizationId', organizationId)
		)
		.unique();
}

/**
 * The caller's watermark. `isFallback` marks the first-visit case, where the
 * page shows the last 24 hours instead of "since you last looked".
 */
// all-members: every member reads only their own watermark (keyed by session.userId).
export const get = authedQuery({
	args: { now: v.optional(v.number()) },
	handler: async (ctx, args, session) => {
		const state = await loadState(ctx, session.userId, session.activeOrganizationId);
		if (state) {
			return {
				seenAt: state.seenAt,
				previousSeenAt: state.previousSeenAt ?? null,
				isFallback: false,
			};
		}
		// `now` comes from the client so the query result is stable between
		// renders; the server clock would re-key the subscription every call.
		const now = args.now ?? 0;
		return {
			seenAt: Math.max(0, now - FIRST_VISIT_LOOKBACK_MS),
			previousSeenAt: null,
			isFallback: true,
		};
	},
});

/**
 * Move the watermark to `at` (clamped to the server clock, never backwards
 * past the previous mark by accident). Keeps the old value in
 * `previousSeenAt` so the page can offer Undo.
 */
// all-members: a member moves only their own watermark (self-scoped by session.userId).
export const markSeen = authedMutation({
	args: { at: v.optional(v.number()) },
	handler: async (ctx, args, session) => {
		const now = Date.now();
		const at = Math.min(args.at ?? now, now);
		const state = await loadState(ctx, session.userId, session.activeOrganizationId);
		if (!state) {
			await ctx.db.insert('todayStates', {
				userId: session.userId,
				organizationId: session.activeOrganizationId,
				seenAt: at,
				updatedAt: now,
			});
			return { seenAt: at, previousSeenAt: null };
		}
		if (at <= state.seenAt)
			return { seenAt: state.seenAt, previousSeenAt: state.previousSeenAt ?? null };
		await ctx.db.patch(state._id, { seenAt: at, previousSeenAt: state.seenAt, updatedAt: now });
		return { seenAt: at, previousSeenAt: state.seenAt };
	},
});

/** Put the watermark back where it was before the last `markSeen`. */
// all-members: self-scoped by session.userId, like markSeen.
export const undoMarkSeen = authedMutation({
	args: {},
	handler: async (ctx, _args, session) => {
		const state = await loadState(ctx, session.userId, session.activeOrganizationId);
		if (!state || state.previousSeenAt === undefined) return { restored: false };
		await ctx.db.patch(state._id, {
			seenAt: state.previousSeenAt,
			previousSeenAt: undefined,
			updatedAt: Date.now(),
		});
		return { restored: true };
	},
});
