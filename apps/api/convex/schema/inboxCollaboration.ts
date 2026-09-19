import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Shared-inbox COLLABORATION tables — the read-side signals about people
 * rather than about mail: who has a thread open, who has seen it, and who was
 * handed one.
 *
 * Split out of `schema/inbox.ts` once that file passed the ~500 LOC guideline
 * in apps/api/convex/CONVENTIONS.md. They belong together: none of them gates a
 * mutation, none writes an audit-log entry, and all three are driven by the
 * thread view rather than by the agent pipeline.
 *
 * Spread into `defineSchema()` from schema.ts via `...inboxCollaborationTables`.
 */
export const inboxCollaborationTables = {
	// Thread Presence - ephemeral "who is here" rows for the shared-inbox thread
	// view. One row per (thread, user); `mode` is `viewing` while the thread is
	// open and `replying` while a reply/review editor is focused. `heartbeatAt`
	// is refreshed every ~20s by the client (inbox/presence.ts → heartbeat); a
	// row is considered ACTIVE only while `heartbeatAt` is within
	// PRESENCE_ACTIVE_WINDOW_MS (60s), and the `sweep expired presence` cron
	// deletes rows past that window. Purely a read-side collaboration hint — it
	// never gates a mutation and never records an audit-log entry.
	threadPresence: defineTable({
		threadId: v.id('conversationThreads'),
		userId: v.string(), // BetterAuth user ID
		mode: v.union(v.literal('viewing'), v.literal('replying')),
		heartbeatAt: v.number(),
	})
		.index('by_thread', ['threadId'])
		.index('by_user', ['userId'])
		.index('by_heartbeat', ['heartbeatAt'])
		// One row per (user, thread) — point-read the caller's own presence on
		// heartbeat/leave via `.unique()` instead of scanning all their rows.
		.index('by_user_thread', ['userId', 'threadId'])
		// Range-scan a thread's ACTIVE rows (heartbeatAt within the window)
		// directly on the index — no in-memory window predicate.
		.index('by_thread_heartbeat', ['threadId', 'heartbeatAt']),

	// Thread Reads - per-user "last seen" marker for shared-inbox threads, the
	// unread counterpart to chat's `chatRoomMembers.lastReadAt`. One row per
	// (user, thread), upserted to `lastSeenAt = now` whenever that user opens the
	// thread. A thread is UNREAD for a user when its `lastMessageAt` is newer than
	// that user's `lastSeenAt` (or they have no row yet). Purely a read-side badge
	// — it never gates a mutation and records no audit-log entry.
	threadReads: defineTable({
		threadId: v.id('conversationThreads'),
		userId: v.string(), // BetterAuth user ID
		lastSeenAt: v.number(),
	})
		// Point-read (and upsert) the caller's own marker for one thread.
		.index('by_user_thread', ['userId', 'threadId']),

	// Assignment Notices - one row per "a teammate assigned this thread to you"
	// event. Written by `inbox.mutations.assignThread` when the new assignee is
	// someone OTHER than the person doing the assigning (self-assign never
	// notifies). The assignee's session subscribes via
	// `inbox.queries.pendingAssignments`, which drives an in-app toast and a
	// desktop notification; the client coalesces bursts and remembers which
	// notices it has already surfaced, so this table is an append-only signal —
	// never mutated, and old rows simply age out of the query window.
	inboxAssignmentNotices: defineTable({
		// Assignee (BetterAuth user id) — who the thread was handed to.
		userId: v.string(),
		threadId: v.id('conversationThreads'),
		// Denormalized at write time so the notice renders without joining.
		subject: v.string(),
		// Display name (or email) of the teammate who did the assigning.
		assignedByName: v.string(),
		createdAt: v.number(),
	})
		// Newest-first window of notices for one assignee.
		.index('by_user_and_created', ['userId', 'createdAt']),
};
