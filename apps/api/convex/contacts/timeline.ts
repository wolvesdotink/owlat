/**
 * Contact Timeline
 *
 * Unified timeline that joins contactActivities (email events)
 * with unifiedMessages (multi-channel messages) to provide
 * a complete chronological view of all interactions with a contact.
 */

import { v } from 'convex/values';
import { authedQuery } from '../lib/authedFunctions';
import { getBetterAuthSessionWithRole, hasPermission } from '../lib/sessionOrganization';
import { parseUnifiedMessageContent } from '../lib/messageBody';
import type { UnifiedMessageContent } from '../lib/messageBody';
import type { Doc, Id } from '../_generated/dataModel';

interface TimelineContent extends UnifiedMessageContent {
	/**
	 * Set on inbound shared-inbox email rows whose body was withheld from a
	 * non-admin caller (ADR-0040). The row, subject, and metadata still render;
	 * only `text`/`html` are dropped.
	 */
	redacted?: boolean;
}

type TimelineEntry =
	| {
			type: 'activity';
			timestamp: number;
			data: {
				_id: Id<'contactActivities'>;
				activityType: Doc<'contactActivities'>['activityType'];
				metadata: Doc<'contactActivities'>['metadata'];
				timestamp: number;
			};
	  }
	| {
			type: 'message';
			timestamp: number;
			data: {
				_id: Id<'unifiedMessages'>;
				channel: Doc<'unifiedMessages'>['channel'];
				direction: Doc<'unifiedMessages'>['direction'];
				content: TimelineContent;
				status: Doc<'unifiedMessages'>['status'];
				externalMessageId?: string;
				threadId: Id<'conversationThreads'>;
				createdAt: number;
			};
	  };

/**
 * Get unified timeline for a contact across all channels
 */
export const getTimeline = authedQuery({
	args: {
		contactId: v.id('contacts'),
		limit: v.optional(v.number()),
		beforeTimestamp: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		// Don't surface a soft-deleted (GDPR-erased) contact's message bodies and
		// activity PII — mirror get()'s guard, which the timeline read otherwise
		// bypasses by querying the child tables directly.
		const contact = await ctx.db.get(args.contactId);
		if (!contact || contact.deletedAt !== undefined) {
			return [];
		}

		// ADR-0040 (shared inbox is owner/admin-only): inbound customer-conversation
		// email CONTENT is restricted to owner/admin in the shared inbox. The same
		// bodies are mirrored into unifiedMessages by inbox/messages.ts
		// (recordInboundMirror) and surface here, so without this gate ANY member
		// (e.g. an editor) could read inbound customer email through the contact
		// timeline — defeating the boundary. Soft role read: members still receive
		// the timeline; we only withhold the body of inbound *email* rows from
		// callers lacking `organization:manage`. Non-email channels and outbound
		// rows are unaffected.
		const session = await getBetterAuthSessionWithRole(ctx);
		const canReadInboundEmail = session?.role
			? hasPermission(session.role, 'organization:manage')
			: false;

		const limit = args.limit ?? 50;
		// Fetch more than needed from each source, then merge and trim. The keyset
		// cursor `beforeTimestamp` is RANGED into each index (not a post-filter):
		// the `limit` newest entries older than the cursor are always within the
		// newest `fetchLimit` of each source, so the merge can't drop an entry — the
		// old post-filter re-fetched the same newest rows and made older pages
		// unreachable once a contact had more than ~fetchLimit recent entries.
		const fetchLimit = limit + 10;
		const before = args.beforeTimestamp;

		// 1. Contact activities (email events: sent, opened, clicked, …) — newest
		//    first via by_contact_and_occurred_at, older than the cursor.
		const activities = await ctx.db
			.query('contactActivities')
			.withIndex('by_contact_and_occurred_at', (q) =>
				before === undefined
					? q.eq('contactId', args.contactId)
					: q.eq('contactId', args.contactId).lt('occurredAt', before)
			)
			.order('desc')
			.take(fetchLimit);

		// 2. Unified messages (multi-channel) — newest first via
		//    by_contact_and_created_at, older than the cursor.
		const messages = await ctx.db
			.query('unifiedMessages')
			.withIndex('by_contact_and_created_at', (q) =>
				before === undefined
					? q.eq('contactId', args.contactId)
					: q.eq('contactId', args.contactId).lt('createdAt', before)
			)
			.order('desc')
			.take(fetchLimit);

		// 3. Merge and sort by timestamp (descending)
		const timeline: TimelineEntry[] = [];

		for (const activity of activities) {
			timeline.push({
				type: 'activity',
				timestamp: activity.occurredAt,
				data: {
					_id: activity._id,
					activityType: activity.activityType,
					metadata: activity.metadata,
					timestamp: activity.occurredAt,
				},
			});
		}

		for (const msg of messages) {
			let content: TimelineContent = parseUnifiedMessageContent(msg.content);
			// ADR-0040: withhold the inbound *email* body from non-admins, but keep
			// the row + its subject/metadata so the timeline stays coherent.
			if (msg.channel === 'email' && msg.direction === 'inbound' && !canReadInboundEmail) {
				content = redactInboundEmailBody(content);
			}
			timeline.push({
				type: 'message',
				timestamp: msg.createdAt,
				data: {
					_id: msg._id,
					channel: msg.channel,
					direction: msg.direction,
					content,
					status: msg.status,
					externalMessageId: msg.externalMessageId,
					threadId: msg.threadId,
					createdAt: msg.createdAt,
				},
			});
		}

		// Sort descending by timestamp
		timeline.sort((a, b) => b.timestamp - a.timestamp);

		return timeline.slice(0, limit);
	},
});

/**
 * Get timeline summary stats for a contact
 */
export const getTimelineStats = authedQuery({
	args: { contactId: v.id('contacts') },
	handler: async (ctx, args) => {
		// Don't surface stats for a soft-deleted (GDPR-erased) contact.
		const contact = await ctx.db.get(args.contactId);
		if (!contact || contact.deletedAt !== undefined) {
			return {
				totalMessages: 0,
				totalActivities: 0,
				totalThreads: 0,
				channelCounts: {},
				activityCounts: {},
				firstInteraction: null,
				lastInteraction: null,
			};
		}
		// Count messages per channel. Capped (matching countByContact) so a
		// long-lived high-traffic contact can't blow the per-query read budget on
		// these unbounded per-contact tables; the totals saturate at the cap.
		const STATS_SCAN_LIMIT = 10_000;
		const messages = await ctx.db
			.query('unifiedMessages')
			.withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
			.take(STATS_SCAN_LIMIT);

		const channelCounts: Record<string, { inbound: number; outbound: number }> = {};
		let firstInteraction = Infinity;
		let lastInteraction = 0;

		for (const msg of messages) {
			if (!channelCounts[msg.channel]) {
				channelCounts[msg.channel] = { inbound: 0, outbound: 0 };
			}
			channelCounts[msg.channel]![msg.direction]++;

			if (msg.createdAt < firstInteraction) firstInteraction = msg.createdAt;
			if (msg.createdAt > lastInteraction) lastInteraction = msg.createdAt;
		}

		// Count activities
		const activities = await ctx.db
			.query('contactActivities')
			.withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
			.take(STATS_SCAN_LIMIT);

		const activityCounts: Record<string, number> = {};
		for (const activity of activities) {
			activityCounts[activity.activityType] = (activityCounts[activity.activityType] ?? 0) + 1;
			if (activity.occurredAt < firstInteraction) firstInteraction = activity.occurredAt;
			if (activity.occurredAt > lastInteraction) lastInteraction = activity.occurredAt;
		}

		// Count threads
		const threads = await ctx.db
			.query('conversationThreads')
			.withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
			.take(STATS_SCAN_LIMIT);

		// The .take() caps return oldest-first (by_contact = _creationTime asc), so
		// the lastInteraction computed above is the 10,000th-oldest timestamp once a
		// contact exceeds the cap. Fold in the true newest row from each table (one
		// bounded indexed read each) so lastInteraction stays correct.
		const newestActivity = await ctx.db
			.query('contactActivities')
			.withIndex('by_contact_and_occurred_at', (q) => q.eq('contactId', args.contactId))
			.order('desc')
			.first();
		if (newestActivity && newestActivity.occurredAt > lastInteraction) {
			lastInteraction = newestActivity.occurredAt;
		}
		const newestMessage = await ctx.db
			.query('unifiedMessages')
			.withIndex('by_contact', (q) => q.eq('contactId', args.contactId))
			.order('desc')
			.first();
		if (newestMessage && newestMessage.createdAt > lastInteraction) {
			lastInteraction = newestMessage.createdAt;
		}

		return {
			totalMessages: messages.length,
			totalActivities: activities.length,
			totalThreads: threads.length,
			channelCounts,
			activityCounts,
			firstInteraction: firstInteraction === Infinity ? null : firstInteraction,
			lastInteraction: lastInteraction === 0 ? null : lastInteraction,
		};
	},
});

// ============================================================
// Helpers
// ============================================================

/**
 * Drop the message body (`text`/`html`) of an inbound shared-inbox email row
 * while preserving the non-sensitive metadata the timeline needs to render
 * (subject, any mediaUrl). See ADR-0040 — the body is owner/admin-only.
 */
function redactInboundEmailBody(content: TimelineContent): TimelineContent {
	const { text: _text, html: _html, ...rest } = content;
	return { ...rest, redacted: true };
}
