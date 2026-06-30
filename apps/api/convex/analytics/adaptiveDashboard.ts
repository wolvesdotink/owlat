/**
 * Adaptive Dashboard
 *
 * Context-driven dashboard layout engine. Evaluates time-of-day,
 * day-of-week, user role, and pending items to determine which
 * cards to show and in what order. Users can customize and pin
 * cards to override the adaptive behavior.
 */

import { v } from 'convex/values';
import { authedQuery, authedMutation, publicQuery } from '../lib/authedFunctions';
import {
	getUserIdFromSession,
	getMutationContext,
	getBetterAuthSessionWithRole,
	type OrganizationRole,
} from '../lib/sessionOrganization';


// ============================================================
// Default Card Definitions
// ============================================================

const DEFAULT_CARDS = [
	{ type: 'verification_queue', label: 'Review Queue', description: 'Pending agent drafts needing review' },
	{ type: 'campaign_performance', label: 'Campaign Performance', description: 'Recent campaign metrics' },
	{ type: 'channel_health', label: 'Channel Health', description: 'Status of all communication channels' },
	{ type: 'agent_health', label: 'Agent Health', description: 'AI agent pipeline metrics' },
	{ type: 'recent_contacts', label: 'Recent Contacts', description: 'Newly added or active contacts' },
	{ type: 'recent_activity', label: 'Recent Activity', description: 'Org-wide audit log and contact activity feed' },
	{ type: 'queue_depth', label: 'Queue Depth', description: 'Inbound message processing queue' },
	{ type: 'delivery_rates', label: 'Delivery Rates', description: 'Email delivery success rates' },
	{ type: 'pinned_visualizations', label: 'Visualizations', description: 'Pinned data visualizations' },
	{ type: 'knowledge_graph', label: 'Knowledge', description: 'Recent knowledge entries' },
	{ type: 'upcoming_campaigns', label: 'Upcoming Campaigns', description: 'Scheduled campaigns' },
	{ type: 'cost_by_step', label: 'LLM Cost by Step', description: 'Token cost per agent-pipeline step' },
	{ type: 'accuracy_trend', label: 'Accuracy Trend', description: 'Auto-approve vs. rejection over time' },
	// Every type here must have a renderer in apps/web's DashboardCardRenderer.vue
	// `cardComponents` map — a type with no renderer shows "Unknown card type" once
	// added.
] as const;

// ============================================================
// Queries
// ============================================================

/**
 * Get the resolved dashboard layout for the current context.
 * Evaluates all rules and returns the ordered list of cards to display.
 */
export const getLayout = authedQuery({
	args: {},
	handler: async (ctx) => {
		// userId gates access (throws if unauthenticated); role is best-effort
		// and only used to match role-scoped layout rules — a null role simply
		// skips those rules rather than denying the layout.
		const userId = await getUserIdFromSession(ctx);
		const sessionWithRole = await getBetterAuthSessionWithRole(ctx);
		const role = sessionWithRole?.role ?? null;
		const layout = await ctx.db
			.query('dashboardLayouts')
			.withIndex('by_user', (q) => q.eq('userId', userId))
			.first();

		if (!layout) {
			return getDefaultLayout();
		}

		const now = new Date();
		const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
		const dayOfWeek = now.getDay();

		// Evaluate rules by priority (highest first)
		const sortedRules = [...layout.rules].sort((a, b) => b.priority - a.priority);

		for (const rule of sortedRules) {
			if (matchesCondition(rule.condition, currentTime, dayOfWeek, role)) {
				// Merge pinned cards with rule cards
				const pinnedCards = layout.pinnedCards ?? [];
				return {
					cards: [
						...pinnedCards.map((c) => ({ ...c, pinned: true })),
						...rule.cards.filter(
							(c) => !pinnedCards.some((p) => p.type === c.type)
						),
					],
					matchedRule: rule,
				};
			}
		}

		// No rule matched — the saved layout is authoritative. The editor seeds
		// from the resolved set and saves the full card list as pinnedCards, so a
		// removed default must NOT be re-appended from getDefaultLayout() (that's
		// what made card removal a no-op). Defaults are only the fallback for a
		// user with no saved row at all (handled above).
		const pinnedCards = layout.pinnedCards ?? [];
		return {
			cards: pinnedCards.map((c) => ({ ...c, pinned: true })),
			matchedRule: null,
		};
	},
});

/**
 * Get available card types
 */
// public: soft-auth — returns empty/safe value for anonymous
export const getAvailableCards = publicQuery({
	args: {},
	handler: async () => {
		return DEFAULT_CARDS;
	},
});

/**
 * Get raw layout configuration for editing
 */
export const getRawLayout = authedQuery({
	args: {},
	handler: async (ctx) => {
		const userId = await getUserIdFromSession(ctx);
		return await ctx.db
			.query('dashboardLayouts')
			.withIndex('by_user', (q) => q.eq('userId', userId))
			.first();
	},
});

// ============================================================
// Mutations
// ============================================================

/**
 * Save a complete dashboard layout
 */
// all-members: per-user — each member manages only their own dashboard layout
// (by_user on session.userId).
export const saveLayout = authedMutation({
	args: {
		// Optional: callers that only update pinnedCards (the pin/unpin UI) omit
		// rules so existing adaptive rules are preserved, not wiped.
		rules: v.optional(v.array(v.object({
			condition: v.object({
				timeRange: v.optional(v.object({
					start: v.string(),
					end: v.string(),
				})),
				dayOfWeek: v.optional(v.array(v.number())),
				role: v.optional(v.string()),
			}),
			cards: v.array(v.object({
				type: v.string(),
				size: v.union(v.literal('small'), v.literal('medium'), v.literal('large')),
			})),
			priority: v.number(),
		}))),
		pinnedCards: v.optional(v.array(v.object({
			type: v.string(),
			size: v.union(v.literal('small'), v.literal('medium'), v.literal('large')),
		}))),
	},
	handler: async (ctx, args) => {
		const session = await getMutationContext(ctx);
		const existing = await ctx.db
			.query('dashboardLayouts')
			.withIndex('by_user', (q) => q.eq('userId', session.userId))
			.first();

		if (existing) {
			await ctx.db.patch(existing._id, {
				// Only overwrite rules when explicitly provided; a pin/unpin save
				// omits them and must not clobber the stored adaptive rules.
				...(args.rules !== undefined ? { rules: args.rules } : {}),
				pinnedCards: args.pinnedCards,
				updatedAt: Date.now(),
			});
			return existing._id;
		}

		return await ctx.db.insert('dashboardLayouts', {
			userId: session.userId,
			rules: args.rules ?? [],
			pinnedCards: args.pinnedCards,
			updatedAt: Date.now(),
		});
	},
});

// ============================================================
// Helpers
// ============================================================

function getDefaultLayout() {
	return {
		cards: [
			{ type: 'verification_queue', size: 'large' as const },
			{ type: 'campaign_performance', size: 'medium' as const },
			{ type: 'channel_health', size: 'small' as const },
			{ type: 'agent_health', size: 'small' as const },
			{ type: 'delivery_rates', size: 'medium' as const },
			{ type: 'recent_contacts', size: 'small' as const },
		],
		matchedRule: null,
	};
}

function matchesCondition(
	condition: {
		timeRange?: { start: string; end: string };
		dayOfWeek?: number[];
		role?: string;
	},
	currentTime: string,
	dayOfWeek: number,
	role: OrganizationRole | null,
): boolean {
	// Check time range
	if (condition.timeRange) {
		const { start, end } = condition.timeRange;
		if (start <= end) {
			// Normal range (e.g., 09:00 - 17:00)
			if (currentTime < start || currentTime > end) return false;
		} else {
			// Overnight range (e.g., 22:00 - 06:00)
			if (currentTime < start && currentTime > end) return false;
		}
	}

	// Check day of week
	if (condition.dayOfWeek && condition.dayOfWeek.length > 0) {
		if (!condition.dayOfWeek.includes(dayOfWeek)) return false;
	}

	// Check role: a rule with a role matches only that role; no role matches all.
	if (condition.role) {
		if (role !== condition.role) return false;
	}

	return true;
}
