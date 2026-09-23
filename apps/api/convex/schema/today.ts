import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Today — the home screen's per-user memory.
 *
 * Today answers "what needs me, what moved, what should I know" across every
 * mailbox a user can read. Two small tables give it the one thing the mail
 * model does not have: a PER-USER notion of "already seen". Read state on a
 * shared mailbox is shared (`mailMessages.flagSeen`), so it cannot tell Ada's
 * "I looked at this thread" apart from Ben's.
 */
export const todayTables = {
	// The "since you last looked" watermark. One row per (user, organization),
	// moved only on purpose: "Mark all as seen", finishing the Answer queue, or
	// a deliberate dwell on Today. `previousSeenAt` keeps the watermark the page
	// was rendered against, so a mark-as-seen can be undone.
	todayStates: defineTable({
		userId: v.string(), // BetterAuth user id
		organizationId: v.string(),
		seenAt: v.number(),
		previousSeenAt: v.optional(v.number()),
		updatedAt: v.number(),
	}).index('by_user_and_organization', ['userId', 'organizationId']),

	// When a user last opened a Postbox thread, and how many messages it held
	// then. Drives the sidebar's "Updated" pill and Today's "What changed" band:
	// a thread that gained messages after the viewer's visit moved without them.
	// The team-inbox side keeps using `threadReads` (inboxCollaboration).
	mailThreadVisits: defineTable({
		userId: v.string(), // BetterAuth user id
		threadId: v.id('mailThreads'),
		mailboxId: v.id('mailboxes'),
		visitedAt: v.number(),
		messageCount: v.number(),
	})
		// Point read per (viewer, thread); the `userId` prefix also serves the
		// member-erasure sweep.
		.index('by_user_and_thread', ['userId', 'threadId']),

	// One-sentence Today summaries of what is new in a conversation, written by
	// the cheap summarizer tier (today/summarize.ts). Keyed by the thread's
	// message count and the count the reader had already seen (`sinceCount`:
	// 0 for a new conversation, the visit's count for "what changed"), plus the
	// reader's locale — so a new message or a different starting point is a
	// cache miss, never a stale sentence. Derived from the thread's content, so
	// it goes with the tenant; it names no reader.
	todayThreadSummaries: defineTable({
		threadId: v.id('mailThreads'),
		locale: v.string(),
		messageCount: v.number(),
		sinceCount: v.number(),
		sentence: v.string(),
		generatedAt: v.number(),
	}).index('by_thread_locale_counts', ['threadId', 'locale', 'messageCount', 'sinceCount']),
};
