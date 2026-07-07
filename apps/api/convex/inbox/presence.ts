/**
 * Thread presence — Convex-native "who is here" for the shared-inbox thread view.
 *
 * A row in `threadPresence` says a given team member currently has a thread open
 * (`mode: 'viewing'`) or is actively drafting a reply/review on it
 * (`mode: 'replying'`). The client heartbeats every ~20s while the thread is
 * open (see apps/web app/composables/useThreadPresence.ts), so a row is treated
 * as ACTIVE only while its `heartbeatAt` is within PRESENCE_ACTIVE_WINDOW_MS.
 * The `internalSweep` cron deletes rows past that window so the table can't grow
 * unbounded when a tab is closed without a clean "leave".
 *
 * This is a pure collaboration hint: it drives the pulsing viewer-ring avatar
 * stack and the "… is replying right now" banner in the thread. It NEVER gates a
 * mutation and — unlike the surrounding inbox mutations (approve/reject/assign/
 * snooze) — deliberately records NO audit-log entry: a heartbeat is a presence
 * signal, not a user action on the record.
 *
 * Access: the shared inbox is admin-only, so `heartbeat` goes through
 * `adminMutation` (owner/admin floor) and `list` mirrors the neighbouring
 * `inbox/queries.ts` reads — a soft-auth `publicQuery` that returns `[]` for
 * anonymous / non-admin callers rather than throwing.
 */

import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { adminMutation, publicQuery } from '../lib/authedFunctions';
import { getMutationContext, getBetterAuthSessionWithRole } from '../lib/sessionOrganization';
import { getOrThrow } from '../_utils/errors';

/**
 * A presence row is ACTIVE while its `heartbeatAt` is within this window of now.
 * The client heartbeats every ~20s, so a 60s window tolerates two missed beats
 * before a viewer is considered gone.
 */
export const PRESENCE_ACTIVE_WINDOW_MS = 60_000;

/**
 * Record (or refresh) the caller's presence on a thread. Called on thread open,
 * then every ~20s while it stays open, and whenever the reply/review editor gains
 * or loses focus (`mode` flips between `viewing` and `replying`).
 *
 * Upsert semantics: one row per (thread, user). No audit-log entry — presence is
 * a signal, not an auditable action.
 */
export const heartbeat = adminMutation({
	args: {
		threadId: v.id('conversationThreads'),
		mode: v.union(v.literal('viewing'), v.literal('replying')),
	},
	handler: async (ctx, args) => {
		const { userId } = await getMutationContext(ctx);
		// Validate thread access the same way the neighbouring reads do — a
		// heartbeat for a deleted / non-existent thread is a no-op error.
		await getOrThrow(ctx, args.threadId, 'Thread');

		const now = Date.now();
		// One row per user; a user rarely has more than a couple of threads open,
		// so scanning their own rows is cheap.
		const mine = await ctx.db
			.query('threadPresence')
			.withIndex('by_user', (q) => q.eq('userId', userId))
			.collect();
		const existing = mine.find((r) => r.threadId === args.threadId);

		if (existing) {
			await ctx.db.patch(existing._id, { mode: args.mode, heartbeatAt: now });
		} else {
			await ctx.db.insert('threadPresence', {
				threadId: args.threadId,
				userId,
				mode: args.mode,
				heartbeatAt: now,
			});
		}
		return { success: true };
	},
});

/**
 * Explicitly drop the caller's presence on a thread (clean "leave" on close).
 * Best-effort — a lost leave is reconciled by the sweep cron within a minute.
 */
export const leave = adminMutation({
	args: {
		threadId: v.id('conversationThreads'),
	},
	handler: async (ctx, args) => {
		const { userId } = await getMutationContext(ctx);
		const mine = await ctx.db
			.query('threadPresence')
			.withIndex('by_user', (q) => q.eq('userId', userId))
			.collect();
		for (const row of mine) {
			if (row.threadId === args.threadId) await ctx.db.delete(row._id);
		}
		return { success: true };
	},
});

/**
 * List the currently-active presence rows for a thread (heartbeat within the
 * active window). Soft-auth: returns `[]` for anonymous / non-admin callers, the
 * same shape as the neighbouring inbox reads. Includes the caller's own row —
 * the client filters itself out.
 */
// public: soft-auth — admin-only shared inbox; returns empty for non-admins
export const list = publicQuery({
	args: {
		threadId: v.id('conversationThreads'),
	},
	handler: async (ctx, args) => {
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!session || (session.role !== 'owner' && session.role !== 'admin')) return [];

		const cutoff = Date.now() - PRESENCE_ACTIVE_WINDOW_MS;
		const rows = await ctx.db
			.query('threadPresence')
			.withIndex('by_thread', (q) => q.eq('threadId', args.threadId))
			.collect();

		return rows
			.filter((r) => r.heartbeatAt > cutoff)
			.map((r) => ({ userId: r.userId, mode: r.mode, heartbeatAt: r.heartbeatAt }));
	},
});

// ── Internal cron sweep ────────────────────────────────────────────

/**
 * Cron entry: delete presence rows whose heartbeat has aged past the active
 * window (tab closed without a clean leave, laptop slept, etc.). Bounded per run;
 * the `by_heartbeat` index keeps the range read tight.
 */
export const internalSweep = internalMutation({
	args: {},
	handler: async (ctx) => {
		const cutoff = Date.now() - PRESENCE_ACTIVE_WINDOW_MS;
		const expired = await ctx.db
			.query('threadPresence')
			.withIndex('by_heartbeat', (q) => q.lt('heartbeatAt', cutoff))
			.take(200);
		for (const row of expired) {
			await ctx.db.delete(row._id);
		}
		return { swept: expired.length };
	},
});
