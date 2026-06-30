/**
 * Inbound Email Queries
 *
 * Queries for the inbox UI: thread listing, message details,
 * review queue, and statistics.
 */

import { v } from 'convex/values';
import { publicQuery } from '../lib/authedFunctions';
import { getBetterAuthSessionWithRole } from '../lib/sessionOrganization';
import { assertFeatureEnabled } from '../lib/featureFlags';

/**
 * List conversation threads with filtering
 */
// public: soft-auth — admin-only shared inbox; returns empty for non-admins
export const listThreads = publicQuery({
	args: {
		status: v.optional(v.union(
			v.literal('open'),
			v.literal('waiting'),
			v.literal('resolved'),
			v.literal('closed')
		)),
		assignedToMe: v.optional(v.boolean()),
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

		// Real keyset pagination via .paginate() — the previous implementation
		// ignored `args.cursor` entirely (so load-more re-returned the first
		// page) and post-filtered `assignedToMe` AFTER .take(), which dropped
		// assigned threads beyond the first window and produced a wrong cursor.
		// Drive the query off an index that already encodes the filter so paging
		// is complete:
		//   - assignedToMe → by_assigned_to (eq this user)
		//   - status only  → by_status (eq status)
		//   - neither      → by_last_message_at
		const base = ctx.db.query('conversationThreads');
		let q;
		if (args.assignedToMe) {
			const userId = session.userId;
			const assigned = base.withIndex('by_assigned_to', (idx) => idx.eq('assignedTo', userId));
			// A status filter composes correctly with .paginate() (filtered-out
			// rows shrink the page but the cursor stays complete).
			q = (args.status ? assigned.filter((f) => f.eq(f.field('status'), args.status!)) : assigned).order('desc');
		} else if (args.status) {
			q = base.withIndex('by_status', (idx) => idx.eq('status', args.status!)).order('desc');
		} else {
			q = base.withIndex('by_last_message_at').order('desc');
		}

		const result = await q.paginate({ cursor: args.cursor ?? null, numItems: limit });

		return {
			threads: result.page,
			nextCursor: result.isDone ? null : result.continueCursor,
		};
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
			.collect();

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
			.collect();
	},
});
