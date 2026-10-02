import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Shared-inbox COLLABORATION tables — the signals about people rather than
 * about mail: who has a thread open, who has seen it, who was handed one, and
 * what the team wrote about it among themselves (internal notes).
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
	// open and `replying` while a reply/review editor is focused. The client
	// beats every ~20s; `heartbeatAt` is rewritten once it is 45s old or the mode
	// changes (inbox/presence.ts → heartbeat). A row is considered ACTIVE only
	// while `heartbeatAt` is within PRESENCE_ACTIVE_WINDOW_MS (90s), and the
	// `sweep expired presence` cron deletes rows past that window. Purely a
	// read-side collaboration hint — it never gates a mutation and never records
	// an audit-log entry.
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
		// What the notice is about. `assignment` (absent = assignment, the
		// original meaning) is a teammate handing over a thread; `clarification`
		// is the agent parking a reply because it needs a fact from this person
		// (inbox/processingLifecycle/effects.ts `notify_clarification`). The
		// client picks its copy by kind.
		// `mention` is a teammate @-mentioning this person in an internal note
		// (inbox/notes.ts); only clients that ask for it receive it
		// (`pendingAssignments({ includeMentions: true })`), so an older tab
		// never words a mention as an assignment.
		// `sla_breach` is a reply target passing unanswered (inbox/sla/breaches.ts),
		// where `assignedByName` carries the waiting customer; likewise only for
		// clients that ask (`includeSlaBreaches: true`).
		kind: v.optional(
			v.union(
				v.literal('assignment'),
				v.literal('clarification'),
				v.literal('mention'),
				v.literal('sla_breach')
			)
		),
		// The parked message, for `clarification` notices only.
		inboundMessageId: v.optional(v.id('inboundMessages')),
		// The note that mentioned the person, for `mention` notices only.
		noteId: v.optional(v.id('threadNotes')),
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

	// Thread Notes - internal notes the team writes on a shared-inbox thread,
	// shown between the messages and never sent: no outbound mail, quoted reply,
	// forward, contact export, webhook or agent prompt reads this table (a guard
	// test lists the modules that may). Plain text with `@handle` mentions
	// (packages/shared/src/chatMentions.ts); `mentionedUserIds` is what the
	// server resolved them to, limited to people who can read the Team Inbox.
	// Edits stamp `editedAt`; a delete keeps the row as a "Note deleted"
	// tombstone with the body and mentions cleared. Member erasure anonymizes
	// the author; a contact's erasure deletes the notes with the thread.
	threadNotes: defineTable({
		threadId: v.id('conversationThreads'),
		authorId: v.string(), // BetterAuth user id ('[deleted account]' once erased)
		body: v.string(),
		mentionedUserIds: v.array(v.string()),
		createdAt: v.number(),
		editedAt: v.optional(v.number()),
		deletedAt: v.optional(v.number()),
	})
		// The thread view, oldest first.
		.index('by_thread_and_created', ['threadId', 'createdAt'])
		// The list's note-count chip: a thread's live (not deleted) notes.
		.index('by_thread_and_deleted', ['threadId', 'deletedAt'])
		// Account export and member erasure.
		.index('by_author', ['authorId']),

	// Thread Note Mentions - one row per (note, mentioned person), mirroring a
	// live note's `mentionedUserIds` so "threads that mention me" is an index
	// read. Rewritten when the note is edited, dropped when it is deleted.
	threadNoteMentions: defineTable({
		noteId: v.id('threadNotes'),
		threadId: v.id('conversationThreads'),
		userId: v.string(), // the mentioned person (BetterAuth user id)
		createdAt: v.number(),
	})
		// The Mentions filter, newest first; also member erasure.
		.index('by_user_and_created', ['userId', 'createdAt'])
		// Keep in step with the note on edit and delete.
		.index('by_note', ['noteId']),
};
