/**
 * Inbound Email Queries
 *
 * Queries for the inbox UI: thread listing, message details,
 * review queue, and statistics.
 */

import { v } from 'convex/values';
import type { QueryCtx } from '../_generated/server';
import { publicQuery } from '../lib/authedFunctions';
import { getBetterAuthSessionWithRole } from '../lib/sessionOrganization';
import { assertFeatureEnabled } from '../lib/featureFlags';
import { PRESENCE_ACTIVE_WINDOW_MS } from './presence';
import { compareNeedsAttention } from './threadSort';

/**
 * Team Inbox filter pills. Each value is one focused slice of the shared inbox:
 *   - open        active conversations, snoozed ones hidden until they wake
 *   - mine        assigned to me and still active (open/waiting)
 *   - unassigned  nobody owns it yet and still active (open/waiting)
 *   - waiting     waiting on the customer's reply
 *   - snoozed     currently snoozed (returns automatically later)
 *   - resolved    marked resolved
 * Absent = every thread (used by the chat "link an inbox thread" picker).
 */
const threadFilterValidator = v.union(
	v.literal('open'),
	v.literal('mine'),
	v.literal('unassigned'),
	v.literal('waiting'),
	v.literal('snoozed'),
	v.literal('resolved')
);

/** How many rows a filter-count pill will read before rendering "99+". */
const FILTER_COUNT_CAP = 100;

type ThreadFilter = 'open' | 'mine' | 'unassigned' | 'waiting' | 'snoozed' | 'resolved';

/**
 * Build the index-driven query for one filter pill. Every branch is indexed so
 * a filter change simply selects a different index — pagination and counts both
 * page cleanly without any O(all-threads) scan. Shared by `listThreads` and
 * `getThreadFilterCounts` so a pill's count and its list always agree.
 *
 * `undefined` filter = every thread (the chat link-thread picker), ordered by
 * recency.
 */
function buildThreadQuery(
	ctx: QueryCtx,
	filter: ThreadFilter | undefined,
	userId: string,
	now: number
) {
	const base = ctx.db.query('conversationThreads');
	switch (filter) {
		case 'open':
			// Active conversations; a snoozed thread stays hidden until it wakes.
			return base
				.withIndex('by_status_and_last_message_at', (idx) => idx.eq('status', 'open'))
				.filter((f) =>
					f.or(f.eq(f.field('snoozedUntil'), undefined), f.lte(f.field('snoozedUntil'), now))
				);
		case 'waiting':
			// Waiting on the customer — also parks snoozed rows under Snoozed only.
			return base
				.withIndex('by_status_and_last_message_at', (idx) => idx.eq('status', 'waiting'))
				.filter((f) =>
					f.or(f.eq(f.field('snoozedUntil'), undefined), f.lte(f.field('snoozedUntil'), now))
				);
		case 'resolved':
			return base.withIndex('by_status_and_last_message_at', (idx) => idx.eq('status', 'resolved'));
		case 'mine':
			// Assigned to me, still active (open/waiting), not currently snoozed.
			return base
				.withIndex('by_assigned_to', (idx) => idx.eq('assignedTo', userId))
				.filter((f) =>
					f.and(
						f.or(f.eq(f.field('status'), 'open'), f.eq(f.field('status'), 'waiting')),
						f.or(f.eq(f.field('snoozedUntil'), undefined), f.lte(f.field('snoozedUntil'), now))
					)
				);
		case 'unassigned':
			return base
				.withIndex('by_assigned_to', (idx) => idx.eq('assignedTo', undefined))
				.filter((f) =>
					f.and(
						f.or(f.eq(f.field('status'), 'open'), f.eq(f.field('status'), 'waiting')),
						f.or(f.eq(f.field('snoozedUntil'), undefined), f.lte(f.field('snoozedUntil'), now))
					)
				);
		case 'snoozed':
			return base.withIndex('by_snoozed_until', (idx) => idx.gt('snoozedUntil', now));
		default:
			return base.withIndex('by_last_message_at');
	}
}

/**
 * List conversation threads with filtering
 */
// public: soft-auth — admin-only shared inbox; returns empty for non-admins
export const listThreads = publicQuery({
	args: {
		filter: v.optional(threadFilterValidator),
		// Ordering. `needs-attention` (the default view) floats drafts-ready then
		// unassigned-unread then oldest-open to the top; `newest` is plain recency.
		sort: v.optional(v.union(v.literal('needs-attention'), v.literal('newest'))),
		limit: v.optional(v.number()),
		cursor: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		await assertFeatureEnabled(ctx, 'inbox');
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!session || (session.role !== 'owner' && session.role !== 'admin')) {
			return { threads: [], nextCursor: null };
		}

		const limit = args.limit ?? 20;
		const now = Date.now();
		const sort = args.sort ?? 'newest';

		// Each filter selects an index that already encodes the slice, so paging
		// stays complete (a filtered-out row shrinks the page but the keyset
		// cursor is still valid). Ordering:
		//   - snoozed         → next-to-wake first (snoozedUntil asc)
		//   - needs-attention → oldest activity first (asc) so the longest-waiting
		//                        thread leads; the page is then re-floated by the
		//                        shared needs-attention comparator.
		//   - newest          → most-recent activity first (desc).
		const built = buildThreadQuery(ctx, args.filter, session.userId, now);
		const order: 'asc' | 'desc' =
			args.filter === 'snoozed' || sort === 'needs-attention' ? 'asc' : 'desc';
		const q = built.order(order);

		const result = await q.paginate({ cursor: args.cursor ?? null, numItems: limit });

		// Enrich each row for the team-inbox list DNA:
		//  - `unread`: activity newer than THIS user's last-seen marker (the
		//    per-user unread badge; mirrors chat's lastReadAt). Bounded: one
		//    point-read per row on `threadReads.by_user_thread`.
		//  - `assignee`: the assigned member's display name/email/image so the row
		//    can render a deterministic-colour avatar without the client joining
		//    to the member directory. Cached per handler so repeat assignees cost
		//    one read.
		const viewerId = session.userId;
		const assigneeCache = new Map<
			string,
			{ name?: string; email: string; image?: string } | null
		>();
		const resolveAssignee = async (userId: string) => {
			if (assigneeCache.has(userId)) return assigneeCache.get(userId)!;
			const profile = await ctx.db
				.query('userProfiles')
				.withIndex('by_auth_user_id', (idx) => idx.eq('authUserId', userId))
				.first();
			const resolved = profile
				? { name: profile.name, email: profile.email, image: profile.image }
				: null;
			assigneeCache.set(userId, resolved);
			return resolved;
		};

		const presenceCutoff = Date.now() - PRESENCE_ACTIVE_WINDOW_MS;
		const threads = await Promise.all(
			result.page.map(async (thread) => {
				const read = await ctx.db
					.query('threadReads')
					.withIndex('by_user_thread', (idx) =>
						idx.eq('userId', viewerId).eq('threadId', thread._id)
					)
					.unique();
				const unread = thread.lastMessageAt > (read?.lastSeenAt ?? 0);
				const assignee = thread.assignedTo ? await resolveAssignee(thread.assignedTo) : null;
				// Does the assignee currently have this thread open? Drives the
				// pulsing presence ring on their row avatar (b3a DNA). Bounded: a
				// single point-read on `by_user_thread` (one row per user+thread,
				// exactly as the presence heartbeat upserts it), and ONLY for
				// assigned threads (unassigned rows skip it entirely).
				let assigneePresent = false;
				if (thread.assignedTo) {
					const presence = await ctx.db
						.query('threadPresence')
						.withIndex('by_user_thread', (idx) =>
							idx.eq('userId', thread.assignedTo!).eq('threadId', thread._id)
						)
						.unique();
					assigneePresent = !!presence && presence.heartbeatAt > presenceCutoff;
				}
				return { ...thread, unread, assignee, assigneePresent };
			})
		);

		// Re-float the fetched page by the needs-attention rule (drafts-ready →
		// unassigned-unread → oldest). The index already delivered rows oldest
		// activity first, so this only lifts the drafts/unread tiers within the
		// loaded window; pagination stays index-driven.
		if (sort === 'needs-attention') threads.sort(compareNeedsAttention);

		return {
			threads,
			nextCursor: result.isDone ? null : result.continueCursor,
		};
	},
});

/**
 * Per-filter thread counts for the Team Inbox filter pills.
 *
 * Each count reads at most `FILTER_COUNT_CAP` rows off the same index the list
 * uses, so a pill never triggers an unbounded scan; a slice at the cap renders
 * as "99+" in the UI. Subscribed only by the inbox landing view.
 */
// public: soft-auth — admin-only shared inbox; returns empty for non-admins
export const getThreadFilterCounts = publicQuery({
	args: {},
	handler: async (ctx) => {
		await assertFeatureEnabled(ctx, 'inbox');
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!session || (session.role !== 'owner' && session.role !== 'admin')) return null;

		const now = Date.now();
		const userId = session.userId;
		const countFilter = async (filter: ThreadFilter) => {
			const rows = await buildThreadQuery(ctx, filter, userId, now).take(FILTER_COUNT_CAP);
			return rows.length;
		};

		const [open, mine, unassigned, waiting, snoozed, resolved] = await Promise.all([
			countFilter('open'),
			countFilter('mine'),
			countFilter('unassigned'),
			countFilter('waiting'),
			countFilter('snoozed'),
			countFilter('resolved'),
		]);

		return { open, mine, unassigned, waiting, snoozed, resolved, cap: FILTER_COUNT_CAP };
	},
});

/**
 * Get a single thread with its messages
 */
// public: soft-auth — admin-only shared inbox; returns empty for non-admins
export const getThread = publicQuery({
	args: {
		threadId: v.id('conversationThreads'),
	},
	handler: async (ctx, args) => {
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!session || (session.role !== 'owner' && session.role !== 'admin')) return null;

		const thread = await ctx.db.get(args.threadId);
		if (!thread) return null;

		// Get all messages in this thread
		const messages = await ctx.db
			.query('inboundMessages')
			.withIndex('by_thread', (q) => q.eq('threadId', args.threadId))
			.order('asc')
			.collect(); // bounded: one thread's inbound messages

		// Get contact info if linked
		let contact = null;
		if (thread.contactId) {
			contact = await ctx.db.get(thread.contactId);
		}

		return {
			thread,
			messages,
			contact,
		};
	},
});

/**
 * Get the review queue — threads with pending drafts needing human attention
 */
// public: soft-auth — admin-only shared inbox; returns empty for non-admins
export const getReviewQueue = publicQuery({
	args: {
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!session || (session.role !== 'owner' && session.role !== 'admin')) return [];

		const limit = args.limit ?? 50;

		// Get messages that are draft_ready
		const pendingMessages = await ctx.db
			.query('inboundMessages')
			.withIndex('by_processing_status', (q) => q.eq('processingStatus', 'draft_ready'))
			.order('desc')
			.take(limit);

		// Enrich with thread and contact data
		const enriched = await Promise.all(
			pendingMessages.map(async (msg) => {
				const thread = msg.threadId ? await ctx.db.get(msg.threadId) : null;
				const contact = msg.contactId ? await ctx.db.get(msg.contactId) : null;
				return { message: msg, thread, contact };
			})
		);

		return enriched;
	},
});

/**
 * Get quarantined messages for admin review
 */
// public: soft-auth — admin-only shared inbox; returns empty for non-admins
export const getQuarantined = publicQuery({
	args: {
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!session || (session.role !== 'owner' && session.role !== 'admin')) return [];

		const limit = args.limit ?? 50;

		const quarantined = await ctx.db
			.query('inboundMessages')
			.withIndex('by_processing_status', (q) => q.eq('processingStatus', 'quarantined'))
			.order('desc')
			.take(limit);

		return quarantined;
	},
});

/**
 * Get permanently-failed inbound messages for admin review.
 *
 * `processingStatus === 'failed'` is a terminal state: the message exhausted
 * the cron auto-retries (`processingLifecycle.retryFailedActions`, max 3) and
 * is no longer making progress. Surfaces each one with its `errorMessage` so
 * an operator can read why it failed and manually re-enqueue it via
 * `inbox.mutations.retryFailedMessage`.
 */
// public: soft-auth — admin-only shared inbox; returns empty for non-admins
export const getFailed = publicQuery({
	args: {
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!session || (session.role !== 'owner' && session.role !== 'admin')) return [];

		const limit = args.limit ?? 50;

		const failed = await ctx.db
			.query('inboundMessages')
			.withIndex('by_processing_status', (q) => q.eq('processingStatus', 'failed'))
			.order('desc')
			.take(limit);

		return failed;
	},
});

/**
 * Get inbound email statistics for the dashboard.
 *
 * Reads the denormalized `instanceSettings.inboxStats` counters
 * maintained by `inbox/messages.ts` (insert) and
 * `inbox/processingLifecycle.ts` (status transitions), plus the
 * `instanceSettings.openThreads` counter maintained by the Conversation
 * thread module (`inbox/threads/module.ts`). The pre-deepening shape did
 * `inboundMessages.collect()` AND a `conversationThreads` open-status
 * collect on every subscriber — and this query is subscribed by the inbox
 * view, the workspace badge, the desktop notifier, and three dashboard
 * cards — so both scans were multiplied by every open dashboard and the
 * open-thread scan grew unbounded whenever the team fell behind.
 */
// public: soft-auth — admin-only shared inbox; returns empty for non-admins
export const getInboundStats = publicQuery({
	args: {},
	handler: async (ctx) => {
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!session || (session.role !== 'owner' && session.role !== 'admin')) return null;

		const settings = await ctx.db.query('instanceSettings').first();
		const counters = settings?.inboxStats ?? {
			received: 0,
			processing: 0,
			draftReady: 0,
			approved: 0,
			sent: 0,
			quarantined: 0,
			failed: 0,
			rejected: 0,
			archived: 0,
			total: 0,
		};

		return {
			total: counters.total,
			received: counters.received,
			processing: counters.processing,
			draftReady: counters.draftReady,
			approved: counters.approved,
			sent: counters.sent,
			quarantined: counters.quarantined,
			failed: counters.failed,
			openThreads: settings?.openThreads ?? 0,
		};
	},
});

/**
 * Get agent action history for a message (pipeline steps timeline)
 */
// public: soft-auth — admin-only shared inbox; returns empty for non-admins
export const getMessageActions = publicQuery({
	args: {
		inboundMessageId: v.id('inboundMessages'),
	},
	handler: async (ctx, args) => {
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!session || (session.role !== 'owner' && session.role !== 'admin')) return [];

		return await ctx.db
			.query('agentActions')
			.withIndex('by_inbound_message', (q) => q.eq('inboundMessageId', args.inboundMessageId))
			.collect(); // bounded: one message's pipeline actions (~1 per step)
	},
});

/**
 * Recent "assigned to you" notices for the current user.
 *
 * Backs the assignment notification: the assignee's session subscribes and,
 * for each newly-arrived notice, fires an in-app toast plus (on desktop) a
 * native notification. The client remembers which notices it has already
 * surfaced and coalesces bursts, so this query only has to return a bounded,
 * newest-first window — stale rows simply fall outside it. Returns [] for
 * non-admins (the shared inbox is admin-only).
 */
// public: soft-auth — self-scoped notices; returns empty for non-admins
export const pendingAssignments = publicQuery({
	args: {
		/** How far back to look. Defaults to 5 minutes. */
		sinceMs: v.optional(v.number()),
		/** Max notices to return. Defaults to 20. */
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const session = await getBetterAuthSessionWithRole(ctx);
		if (!session || (session.role !== 'owner' && session.role !== 'admin')) return [];

		const window = args.sinceMs ?? 5 * 60 * 1000;
		const cutoff = Date.now() - window;
		const limit = args.limit ?? 20;

		const rows = await ctx.db
			.query('inboxAssignmentNotices')
			.withIndex('by_user_and_created', (q) =>
				q.eq('userId', session.userId).gte('createdAt', cutoff)
			)
			.order('desc')
			.take(limit);

		return rows.map((r) => ({
			id: r._id,
			threadId: r.threadId,
			subject: r.subject,
			assignedByName: r.assignedByName,
			createdAt: r.createdAt,
		}));
	},
});
