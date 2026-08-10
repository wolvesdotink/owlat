import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../schema';
import { api } from '../_generated/api';
import * as sessionOrganization from '../lib/sessionOrganization';
import type { OrganizationRole } from '../lib/sessionOrganization';

/**
 * Auth enforcement tests for adaptiveDashboard (C1).
 *
 * Before the fix, the endpoints accepted a caller-supplied `userId`
 * and operated on the dashboardLayouts row keyed by that arg — letting any
 * caller read or overwrite another user's dashboard.
 *
 * After the fix:
 *   - queries call `getUserIdFromSession(ctx)` (throws if not authed)
 *   - mutations call `getMutationContext(ctx)` (throws if not authed)
 *   - `userId` is removed from the args schema entirely
 *
 * These tests mock the session helpers and assert (a) unauthenticated
 * callers are rejected, and (b) a different session's userId is used
 * regardless of the args shape.
 */

let mockUserId: string | null = 'user-A';
let mockRole: OrganizationRole | null = 'owner';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof import('../lib/sessionOrganization')>(
		'../lib/sessionOrganization'
	);
	return {
		...actual,
		// Dynamic, not a fixed resolved value: this is BOTH the floor `authedQuery`
		// runs and — for `getAvailableCards` — the gate the handler itself calls, so
		// the "unauthenticated is refused" and "role decides the cards" cases have
		// to be able to drive it.
		requireOrgMember: vi.fn(async () => {
			if (!mockUserId) throw new Error('Not authenticated');
			if (!mockRole) throw new Error('You do not have access to this organization');
			return { userId: mockUserId, role: mockRole, activeOrganizationId: 'org-1' };
		}),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn(async () => {
			if (!mockUserId) throw new Error('Not authenticated');
			return mockUserId;
		}),
		getBetterAuthSessionWithRole: vi.fn(async () => {
			if (!mockUserId || !mockRole) return null;
			return { userId: mockUserId, role: mockRole };
		}),
		getMutationContext: vi.fn(async () => {
			if (!mockUserId || !mockRole) throw new Error('Not authenticated');
			return { userId: mockUserId, role: mockRole };
		}),
	};
});

const modules = import.meta.glob('../**/*.*s');

beforeEach(() => {
	mockUserId = 'user-A';
	mockRole = 'owner';
	// Call COUNTS are asserted below (the point of C1's follow-up is that the
	// session is resolved once per call), so the counters start clean.
	// `mockClear` only drops recorded calls — the factory implementations above
	// survive it.
	vi.clearAllMocks();
});

describe('adaptiveDashboard.getLayout — auth', () => {
	it('throws when unauthenticated', async () => {
		const t = convexTest(schema, modules);
		mockUserId = null;
		await expect(t.query(api.analytics.adaptiveDashboard.getLayout, {})).rejects.toThrow(
			/Not authenticated/
		);
	});

	it('reads the session user layout, never a caller-supplied id', async () => {
		const t = convexTest(schema, modules);
		// Seed two layouts pinning non-default cards so the assertion isn't
		// confounded by getDefaultLayout()'s contents.
		await t.run(async (ctx) => {
			await ctx.db.insert('dashboardLayouts', {
				userId: 'user-A',
				rules: [],
				pinnedCards: [{ type: 'queue_depth', size: 'medium' as const }],
				updatedAt: Date.now(),
			});
			await ctx.db.insert('dashboardLayouts', {
				userId: 'user-B',
				rules: [],
				pinnedCards: [{ type: 'knowledge_graph', size: 'medium' as const }],
				updatedAt: Date.now(),
			});
		});

		// Calling as user-A — should see user-A's pinned card, not user-B's
		mockUserId = 'user-A';
		const result = await t.query(api.analytics.adaptiveDashboard.getLayout, {});
		const pinned = result.cards.filter((c) => (c as { pinned?: boolean }).pinned);
		const pinnedTypes = pinned.map((c) => c.type);
		expect(pinnedTypes).toEqual(['queue_depth']);
		expect(pinnedTypes).not.toContain('knowledge_graph');
	});

	it('a saved layout is authoritative — a removed default card stays removed', async () => {
		const t = convexTest(schema, modules);
		// User saved a layout that deliberately OMITS the default 'agent_health'
		// card (the editor saves the full edited set as pinnedCards).
		await t.run(async (ctx) => {
			await ctx.db.insert('dashboardLayouts', {
				userId: 'user-C',
				rules: [],
				pinnedCards: [
					{ type: 'campaign_performance', size: 'medium' as const },
					{ type: 'recent_contacts', size: 'small' as const },
				],
				updatedAt: Date.now(),
			});
		});

		mockUserId = 'user-C';
		const result = await t.query(api.analytics.adaptiveDashboard.getLayout, {});
		const types = result.cards.map((c) => c.type);
		// Only the saved cards — defaults are NOT re-appended.
		expect(types).toEqual(['campaign_performance', 'recent_contacts']);
		expect(types).not.toContain('agent_health');
	});
});

describe('adaptiveDashboard.saveLayout — auth', () => {
	it('throws when unauthenticated', async () => {
		const t = convexTest(schema, modules);
		mockUserId = null;
		await expect(
			t.mutation(api.analytics.adaptiveDashboard.saveLayout, { rules: [], pinnedCards: [] })
		).rejects.toThrow(/Not authenticated/);
	});

	it('writes to the session user, not a caller-supplied id', async () => {
		const t = convexTest(schema, modules);
		mockUserId = 'user-A';

		await t.mutation(api.analytics.adaptiveDashboard.saveLayout, {
			rules: [],
			pinnedCards: [{ type: 'recent_contacts', size: 'small' }],
		});

		await t.run(async (ctx) => {
			const aLayout = await ctx.db
				.query('dashboardLayouts')
				.withIndex('by_user', (q) => q.eq('userId', 'user-A'))
				.first();
			expect(aLayout?.pinnedCards?.[0]?.type).toBe('recent_contacts');

			const bLayout = await ctx.db
				.query('dashboardLayouts')
				.withIndex('by_user', (q) => q.eq('userId', 'user-B'))
				.first();
			expect(bLayout).toBeNull();
		});
	});

	it('cannot overwrite another user', async () => {
		const t = convexTest(schema, modules);
		// Seed user-B layout
		await t.run(async (ctx) => {
			await ctx.db.insert('dashboardLayouts', {
				userId: 'user-B',
				rules: [],
				pinnedCards: [{ type: 'channel_health', size: 'small' as const }],
				updatedAt: Date.now(),
			});
		});

		// Acting as user-A — saveLayout should affect user-A only.
		mockUserId = 'user-A';
		await t.mutation(api.analytics.adaptiveDashboard.saveLayout, {
			rules: [],
			pinnedCards: [{ type: 'agent_health', size: 'small' }],
		});

		await t.run(async (ctx) => {
			const bLayout = await ctx.db
				.query('dashboardLayouts')
				.withIndex('by_user', (q) => q.eq('userId', 'user-B'))
				.first();
			// user-B unchanged
			expect(bLayout?.pinnedCards?.[0]?.type).toBe('channel_health');
		});
	});
});

describe('adaptiveDashboard.getAvailableCards', () => {
	// The card types that have a renderer in apps/web's DashboardCardRenderer.vue
	// `cardComponents` map. getAvailableCards must never advertise a type absent
	// here, or the user can add a card that renders "Unknown card type".
	const RENDERABLE_CARD_TYPES = new Set([
		'verification_queue',
		'campaign_performance',
		'channel_health',
		'agent_health',
		'recent_contacts',
		'recent_activity',
		'queue_depth',
		'delivery_rates',
		'pinned_visualizations',
		'knowledge_graph',
		'upcoming_campaigns',
		'cost_by_step',
		'accuracy_trend',
	]);

	it('returns only card types that have a renderer', async () => {
		const t = convexTest(schema, modules);
		const cards = await t.query(api.analytics.adaptiveDashboard.getAvailableCards, {});
		const unrenderable = cards
			.map((c) => c.type)
			.filter((type) => !RENDERABLE_CARD_TYPES.has(type));
		expect(unrenderable).toEqual([]);
	});

	it('advertises cost_by_step / accuracy_trend now that they render', async () => {
		const t = convexTest(schema, modules);
		const cards = await t.query(api.analytics.adaptiveDashboard.getAvailableCards, {});
		const types = cards.map((c) => c.type);
		expect(types).toContain('cost_by_step');
		expect(types).toContain('accuracy_trend');
	});

	it('refuses an anonymous caller', async () => {
		const t = convexTest(schema, modules);
		mockUserId = null;
		await expect(t.query(api.analytics.adaptiveDashboard.getAvailableCards, {})).rejects.toThrow(
			/Not authenticated/
		);
	});

	it('refuses an authenticated non-member', async () => {
		const t = convexTest(schema, modules);
		mockRole = null;
		await expect(t.query(api.analytics.adaptiveDashboard.getAvailableCards, {})).rejects.toThrow(
			/do not have access to this organization/
		);
	});

	it('filters an editor down to the task cards, and gives an admin all of them', async () => {
		const t = convexTest(schema, modules);

		mockRole = 'editor';
		const editorCards = await t.query(api.analytics.adaptiveDashboard.getAvailableCards, {});
		expect(editorCards.map((c) => c.type).sort()).toEqual([
			'campaign_performance',
			'pinned_visualizations',
			'recent_contacts',
			'upcoming_campaigns',
		]);

		mockRole = 'admin';
		const adminCards = await t.query(api.analytics.adaptiveDashboard.getAvailableCards, {});
		expect(adminCards).toHaveLength(RENDERABLE_CARD_TYPES.size);
	});

	it('resolves the session ONCE — the role comes out of the membership gate', async () => {
		// The regression this pins: `authedQuery` + an in-handler
		// `getBetterAuthSessionWithRole` meant two BetterAuth session/member
		// resolutions on every run of a query the dashboard editor live-subscribes,
		// all to filter a 13-element constant.
		const t = convexTest(schema, modules);
		await t.query(api.analytics.adaptiveDashboard.getAvailableCards, {});
		expect(vi.mocked(sessionOrganization.requireOrgMember)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(sessionOrganization.getBetterAuthSessionWithRole)).not.toHaveBeenCalled();
	});
});
