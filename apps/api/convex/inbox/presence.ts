/**
 * Thread presence — Convex-native "who is here" for the shared-inbox thread view.
 *
 * A row in `threadPresence` says a given team member currently has a thread open
 * (`mode: 'viewing'`) or is actively drafting a reply/review on it
 * (`mode: 'replying'`). The client heartbeats every ~20s while the thread is
 * open (see apps/web app/composables/useThreadPresence.ts), but a beat only
 * rewrites the row when its mode changed or its `heartbeatAt` is at least
 * PRESENCE_REFRESH_MS old: every write re-runs the presence reads that name
 * the row (`list`, `presentAssignees`). A row is treated as ACTIVE only while its
 * `heartbeatAt` is within PRESENCE_ACTIVE_WINDOW_MS.
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
import type { QueryCtx, MutationCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { adminMutation, publicQuery } from '../lib/authedFunctions';
import { getMutationContext, getBetterAuthSessionWithRole } from '../lib/sessionOrganization';
import { isSharedInboxReader } from './access';
import { getOrThrow } from '../_utils/errors';

/** The client's heartbeat cadence (useThreadPresence.ts). */
const PRESENCE_HEARTBEAT_INTERVAL_MS = 20_000;

/**
 * A beat in the same mode leaves the row alone until its `heartbeatAt` is this
 * old, so an open thread costs one write per ~45-65s instead of one per beat.
 */
export const PRESENCE_REFRESH_MS = 45_000;

/**
 * A presence row is ACTIVE while its `heartbeatAt` is within this window of now.
 * With every beat arriving, a stored row is at most one beat past
 * PRESENCE_REFRESH_MS old; the window adds one missed beat and 5s of slack
 * (90s) before a viewer is considered gone.
 */
export const PRESENCE_ACTIVE_WINDOW_MS =
	PRESENCE_REFRESH_MS + 2 * PRESENCE_HEARTBEAT_INTERVAL_MS + 5_000;

/**
 * Record (or refresh) the caller's presence on a thread. Called on thread open,
 * then every ~20s while it stays open, and whenever the reply/review editor gains
 * or loses focus (`mode` flips between `viewing` and `replying`).
 *
 * Upsert semantics: one row per (thread, user); a same-mode beat inside
 * PRESENCE_REFRESH_MS is a no-op. No audit-log entry — presence is a signal,
 * not an auditable action.
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
		// One row per (user, thread) — point-read the caller's own presence.
		const existing = await ctx.db
			.query('threadPresence')
			.withIndex('by_user_thread', (q) => q.eq('userId', userId).eq('threadId', args.threadId))
			.unique();

		if (existing) {
			// Same mode and still well inside the active window: nothing a reader
			// would see changes, so skip the write.
			if (existing.mode === args.mode && now - existing.heartbeatAt < PRESENCE_REFRESH_MS) {
				return { success: true };
			}
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
 * Best-effort — a lost leave is reconciled once the row leaves the active
 * window (the sweep cron deletes it within a minute after that).
 */
export const leave = adminMutation({
	args: {
		threadId: v.id('conversationThreads'),
	},
	handler: async (ctx, args) => {
		const { userId } = await getMutationContext(ctx);
		// One row per (user, thread) — point-read and drop it if present.
		const existing = await ctx.db
			.query('threadPresence')
			.withIndex('by_user_thread', (q) => q.eq('userId', userId).eq('threadId', args.threadId))
			.unique();
		if (existing) await ctx.db.delete(existing._id);
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
		if (!isSharedInboxReader(session)) return [];

		const cutoff = Date.now() - PRESENCE_ACTIVE_WINDOW_MS;
		// Range-scan only the ACTIVE rows for this thread (heartbeat within the
		// window) via the compound index — no in-memory window filter.
		const rows = await ctx.db
			.query('threadPresence')
			.withIndex('by_thread_heartbeat', (q) =>
				q.eq('threadId', args.threadId).gt('heartbeatAt', cutoff)
			)
			.collect(); // bounded: one row per (thread, present team member), capped by team size

		return rows.map((r) => ({ userId: r.userId, mode: r.mode, heartbeatAt: r.heartbeatAt }));
	},
});

/**
 * Upper bound on (thread, assignee) pairs one `presentAssignees` call checks.
 * The team inbox pages 25 rows at a time; past this many loaded rows the
 * extra ones simply show no ring.
 */
export const MAX_ASSIGNEE_PRESENCE_PAIRS = 200;

/**
 * Which of the given threads have their assignee there right now: the
 * pulsing ring on a team-inbox row's assignee avatar. Returns the thread ids
 * whose (thread, assignee) presence row is inside the active window.
 *
 * This used to be read inside `inbox/queries.ts` `listThreads`, so every
 * presence write re-ran every admin's thread list, including the one the
 * shell sidebar keeps mounted. Only the Team Inbox list page shows the ring,
 * so it asks here with its visible assigned rows and nothing else subscribes.
 * Each pair is one point-read on `by_user_thread`, so a heartbeat only
 * re-runs the calls that name that exact (user, thread).
 *
 * The caller names the assignee: the list row already carries it, and an
 * admin can read any thread's presence through `list` anyway. Soft-auth like
 * `list`: `[]` for anonymous / non-admin callers.
 */
// public: soft-auth — admin-only shared inbox; returns empty for non-admins
export const presentAssignees = publicQuery({
	args: {
		rows: v.array(
			v.object({
				threadId: v.id('conversationThreads'),
				assigneeId: v.string(),
			})
		),
	},
	handler: async (ctx, args) => {
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!isSharedInboxReader(session)) return [];

		const cutoff = Date.now() - PRESENCE_ACTIVE_WINDOW_MS;
		const checked = await Promise.all(
			args.rows.slice(0, MAX_ASSIGNEE_PRESENCE_PAIRS).map(async ({ threadId, assigneeId }) => {
				const row = await ctx.db
					.query('threadPresence')
					.withIndex('by_user_thread', (q) => q.eq('userId', assigneeId).eq('threadId', threadId))
					.unique();
				return row && row.heartbeatAt > cutoff ? threadId : null;
			})
		);
		return checked.filter((id): id is Id<'conversationThreads'> => id !== null);
	},
});

// ── Collision soft-hold helper ─────────────────────────────────────

/**
 * The other team member (if any) who is ACTIVELY replying to this thread right
 * now, ignoring the caller's own presence. "Active" mirrors `list`: a
 * `replying`-mode row whose heartbeat is inside PRESENCE_ACTIVE_WINDOW_MS.
 *
 * This is the predicate behind the b3b soft-hold: the reply composer / Approve &
 * Send button renders HELD (disabled-styled but visible) while this returns a
 * teammate, and the `approveDraft` mutation re-checks it at execution time so a
 * held button that slipped through still can't quietly double-answer. It is
 * advisory only — last-writer-wins if two callers race past it — and self is
 * never counted, so your own `replying` row never holds your own button.
 *
 * Returns the first such teammate's userId, or `null` when nobody else is
 * replying (viewers don't hold — you can send while a teammate merely reads).
 */
export async function getActiveReplierOtherThan(
	ctx: QueryCtx | MutationCtx,
	threadId: Id<'conversationThreads'>,
	excludeUserId: string
): Promise<{ userId: string } | null> {
	const cutoff = Date.now() - PRESENCE_ACTIVE_WINDOW_MS;
	// Range-scan only ACTIVE rows for this thread via the compound index, then
	// keep the first OTHER user in `replying` mode. Bounded by team size.
	const rows = await ctx.db
		.query('threadPresence')
		.withIndex('by_thread_heartbeat', (q) => q.eq('threadId', threadId).gt('heartbeatAt', cutoff))
		.collect(); // bounded: one thread's active presence rows (bounded by team size)
	const other = rows.find((r) => r.mode === 'replying' && r.userId !== excludeUserId);
	return other ? { userId: other.userId } : null;
}

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
