import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Dashboard tables — AI-generated visualizations + per-user adaptive layouts.
 *
 * Spread into `defineSchema()` from schema.ts via `...dashboardTables`.
 */
export const dashboardTables = {
	// Visualizations - AI-generated interactive HTML/CSS/JS visualizations
	visualizations: defineTable({
		title: v.string(),
		description: v.optional(v.string()),
		// Self-contained HTML document (HTML + CSS + JS)
		html: v.string(),
		// Convex query used to generate data (for refresh)
		dataQuery: v.optional(v.string()),
		// Dashboard integration
		pinned: v.boolean(),
		// Creator
		createdBy: v.string(), // User or agent ID
		threadId: v.optional(v.id('conversationThreads')),
		createdAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_pinned', ['pinned'])
		.index('by_created_at', ['createdAt']),

	// Per-day send roll-up — populated by the `daily_stats_bump` Send
	// lifecycle effect. The Dashboard summary card (`getStats`) reads at
	// most 30 of these rows; the pre-deepening shape did
	// `campaigns.collect()` + `transactionalSends.take(5000)` on every
	// subscriber, which fan-out-invalidated on every send event.
	sendDailyStats: defineTable({
		date: v.string(), // 'YYYY-MM-DD' in UTC
		// Write shard within (date): every send/delivered/opened/clicked event
		// bumps a random shard so concurrent events spread across SHARD_COUNT rows
		// instead of contending on a single deployment-wide today-row (OCC hotspot).
		// readDailyStats sums across shards. See lib/sendDailyStats.ts.
		shardKey: v.number(),
		sent: v.number(),
		delivered: v.number(),
		opened: v.number(),
		clicked: v.number(),
	})
		.index('by_date', ['date'])
		.index('by_date_shard', ['date', 'shardKey']),

	// Dashboard Layouts - per-user adaptive dashboard configuration
	dashboardLayouts: defineTable({
		userId: v.string(),
		// Context-driven layout rules
		rules: v.array(v.object({
			condition: v.object({
				timeRange: v.optional(v.object({
					start: v.string(), // e.g., '06:00'
					end: v.string(),   // e.g., '12:00'
				})),
				dayOfWeek: v.optional(v.array(v.number())), // 0=Sun, 1=Mon, etc.
				role: v.optional(v.string()),
			}),
			cards: v.array(v.object({
				type: v.string(),    // 'verification_queue', 'campaign_performance', etc.
				size: v.union(v.literal('small'), v.literal('medium'), v.literal('large')),
			})),
			priority: v.number(),
		})),
		// Pinned cards always show regardless of context
		pinnedCards: v.optional(v.array(v.object({
			type: v.string(),
			size: v.union(v.literal('small'), v.literal('medium'), v.literal('large')),
		}))),
		updatedAt: v.number(),
	})
		.index('by_user', ['userId']),
};
