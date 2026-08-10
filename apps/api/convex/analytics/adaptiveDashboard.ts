/**
 * Adaptive Dashboard
 *
 * Context-driven dashboard layout engine. Evaluates time-of-day,
 * day-of-week, user role, and pending items to determine which
 * cards to show and in what order. Users can customize and pin
 * cards to override the adaptive behavior.
 */

import { v } from 'convex/values';
import { authedQuery, authedMutation } from '../lib/authedFunctions';
import type { OrganizationRole } from '../lib/sessionOrganization';

// ============================================================
// Default Card Definitions
// ============================================================

const DEFAULT_CARDS = [
	{
		type: 'verification_queue',
		label: 'Review Queue',
		description: 'Pending agent drafts needing review',
	},
	{
		type: 'campaign_performance',
		label: 'Campaign Performance',
		description: 'Recent campaign metrics',
	},
	{
		type: 'channel_health',
		label: 'Channel Health',
		description: 'Status of all communication channels',
	},
	{ type: 'agent_health', label: 'Agent Health', description: 'AI agent pipeline metrics' },
	{
		type: 'recent_contacts',
		label: 'Recent Contacts',
		description: 'Newly added or active contacts',
	},
	{
		type: 'recent_activity',
		label: 'Recent Activity',
		description: 'Org-wide audit log and contact activity feed',
	},
	{ type: 'queue_depth', label: 'Queue Depth', description: 'Inbound message processing queue' },
	{ type: 'delivery_rates', label: 'Delivery Rates', description: 'Email delivery success rates' },
	{
		type: 'pinned_visualizations',
		label: 'Visualizations',
		description: 'Pinned data visualizations',
	},
	{ type: 'knowledge_graph', label: 'Knowledge', description: 'Recent knowledge entries' },
	{ type: 'upcoming_campaigns', label: 'Upcoming Campaigns', description: 'Scheduled campaigns' },
	{
		type: 'cost_by_step',
		label: 'LLM Cost by Step',
		description: 'Token cost per agent-pipeline step',
	},
	{
		type: 'accuracy_trend',
		label: 'Accuracy Trend',
		description: 'Auto-approve vs. rejection over time',
	},
	// Every type here must have a renderer in apps/web's DashboardCardRenderer.vue
	// `cardComponents` map — a type with no renderer shows "Unknown card type" once
	// added.
] as const;

/** Task/data cards editors can use without exposing organization operations. */
const EDITOR_CARD_TYPES = new Set([
	'campaign_performance',
	'recent_contacts',
	'pinned_visualizations',
	'upcoming_campaigns',
]);

function canViewCard(type: string, role: OrganizationRole): boolean {
	if (role === 'owner' || role === 'admin') return true;
	return EDITOR_CARD_TYPES.has(type);
}

function visibleCards<T extends { type: string }>(
	cards: readonly T[],
	role: OrganizationRole
): T[] {
	return cards.filter((card) => canViewCard(card.type, role));
}

// ============================================================
// Queries
// ============================================================

/**
 * Get the resolved dashboard layout for the current context.
 * Evaluates all rules and returns the ordered list of cards to display.
 *
 * `userId` and `role` both come from the session `authedQuery`'s floor already
 * resolved and threads in. This used to be THREE resolutions per call — the
 * floor, then `getUserIdFromSession`, then `getBetterAuthSessionWithRole` — on
 * the query every dashboard page subscribes to. The role is also no longer
 * "best-effort": the floor rejects a caller without one, so the layout is
 * always filtered against a real role rather than falling through to the
 * null-role path that could never be reached behind it.
 */
export const getLayout = authedQuery({
	args: {},
	handler: async (ctx, _args, session) => {
		const { userId, role } = session;
		const layout = await ctx.db
			.query('dashboardLayouts')
			.withIndex('by_user', (q) => q.eq('userId', userId))
			.first();

		if (!layout) {
			return getDefaultLayout(role);
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
					cards: visibleCards(
						[
							...pinnedCards.map((c) => ({ ...c, pinned: true })),
							...rule.cards.filter((c) => !pinnedCards.some((p) => p.type === c.type)),
						],
						role
					),
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
			cards: visibleCards(
				pinnedCards.map((c) => ({ ...c, pinned: true })),
				role
			),
			matchedRule: null,
		};
	},
});

/**
 * Get available card types, filtered to what the caller's organization role may
 * see.
 *
 * ONE session resolution per call. The card list is a 13-element constant, so the
 * only real work is deciding the caller's role — and that is already decided when
 * the handler runs: `authedQuery`'s floor (`requireOrgMember` →
 * `getBetterAuthSessionWithRole`) resolved the session, looked the BetterAuth
 * `member` row up, and threads the result in as the third argument. Reading
 * `session.role` here is therefore free; re-resolving it in the handler is what
 * used to make a live-subscribed query pay for two `member` lookups.
 */
// all-members: card definitions are metadata every org member may read, filtered
// to the caller's role.
export const getAvailableCards = authedQuery({
	args: {},
	handler: async (_ctx, _args, session) => visibleCards(DEFAULT_CARDS, session.role),
});

/**
 * Get raw layout configuration for editing. Keyed by the session user the floor
 * admitted — never a caller-supplied id.
 */
export const getRawLayout = authedQuery({
	args: {},
	handler: async (ctx, _args, session) =>
		ctx.db
			.query('dashboardLayouts')
			.withIndex('by_user', (q) => q.eq('userId', session.userId))
			.first(),
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
		rules: v.optional(
			v.array(
				v.object({
					condition: v.object({
						timeRange: v.optional(
							v.object({
								start: v.string(),
								end: v.string(),
							})
						),
						dayOfWeek: v.optional(v.array(v.number())),
						role: v.optional(v.string()),
					}),
					cards: v.array(
						v.object({
							type: v.string(),
							size: v.union(v.literal('small'), v.literal('medium'), v.literal('large')),
						})
					),
					priority: v.number(),
				})
			)
		),
		pinnedCards: v.optional(
			v.array(
				v.object({
					type: v.string(),
					size: v.union(v.literal('small'), v.literal('medium'), v.literal('large')),
				})
			)
		),
	},
	handler: async (ctx, args, session) => {
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

function getDefaultLayout(role: OrganizationRole) {
	return {
		cards: visibleCards(
			[
				{ type: 'verification_queue', size: 'large' as const },
				{ type: 'campaign_performance', size: 'medium' as const },
				{ type: 'channel_health', size: 'small' as const },
				{ type: 'agent_health', size: 'small' as const },
				{ type: 'delivery_rates', size: 'medium' as const },
				{ type: 'recent_contacts', size: 'small' as const },
			],
			role
		),
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
	role: OrganizationRole
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
