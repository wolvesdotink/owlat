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
 *   - `userId` is removed from the args schema entirely, and every handler keys
 *     off the session its builder's floor resolved and threads in as the third
 *     argument (`authedQuery` → `requireOrgMember`, `authedMutation` →
 *     `getMutationContext`, which delegates to the same helper)
 *   - so the floor is BOTH the authentication gate and the only session lookup:
 *     no handler in this module calls a session helper of its own. Each endpoint
 *     below carries a call-count pin for that, because re-adding an in-handler
 *     `getUserIdFromSession` / `getBetterAuthSessionWithRole` /
 *     `getMutationContext` is silent — correct, just twice the BetterAuth
 *     session + `member` work on queries every dashboard page subscribes to.
 *
 * These tests mock the session helpers and assert (a) unauthenticated
 * callers are rejected, (b) a different session's userId is used
 * regardless of the args shape, and (c) the resolution count.
 */

let mockUserId: string | null = 'user-A';
let mockRole: OrganizationRole | null = 'owner';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof import('../lib/sessionOrganization')>(
		'../lib/sessionOrganization'
	);
	return {
		...actual,
		// Dynamic, not a fixed resolved value: this is the floor every query in the
		// module runs, and — since the floor threads its result into the handler —
		// also the single source of the `userId` each layout is keyed by and the
		// `role` the cards are filtered against. So the "unauthenticated is refused",
		// "another user's row is untouchable" and "role decides the cards" cases all
		// drive it.
		requireOrgMember: vi.fn(async () => {
			if (!mockUserId) throw new Error('Not authenticated');
			if (!mockRole) throw new Error('You do not have access to this organization');
			return { userId: mockUserId, role: mockRole, activeOrganizationId: 'org-1' };
		}),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		// `authedMutation`'s floor. Kept faithful to the real helper (which delegates
		// to `requireOrgMember`) so `saveLayout` sees the same session its queries do.
		getMutationContext: vi.fn(async () => {
			if (!mockUserId) throw new Error('Not authenticated');
			if (!mockRole) throw new Error('You do not have access to this organization');
			return { userId: mockUserId, role: mockRole, activeOrganizationId: 'org-1' };
		}),
		// The two helpers the handlers USED to call on top of their floor. Mocked so
		// they are counted, and expected never to run: the pins below are what keeps
		// a second session resolution from creeping back in.
		getUserIdFromSession: vi.fn(async () => {
			if (!mockUserId) throw new Error('Not authenticated');
			return mockUserId;
		}),
		getBetterAuthSessionWithRole: vi.fn(async () => {
			if (!mockUserId || !mockRole) return null;
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

	it('resolves the session ONCE — both the user and the role come from the floor', async () => {
		// This handler cost THREE resolutions before: `authedQuery`'s floor, then
		// `getUserIdFromSession` for the layout key, then
		// `getBetterAuthSessionWithRole` for the role the rules match on.
		const t = convexTest(schema, modules);
		await t.query(api.analytics.adaptiveDashboard.getLayout, {});
		expect(vi.mocked(sessionOrganization.requireOrgMember)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(sessionOrganization.getUserIdFromSession)).not.toHaveBeenCalled();
		expect(vi.mocked(sessionOrganization.getBetterAuthSessionWithRole)).not.toHaveBeenCalled();
	});

	it('filters the resolved layout by the caller’s role', async () => {
		// The role is no longer best-effort: the floor refuses a caller without one,
		// so an editor's layout is filtered rather than falling through a null-role
		// path that could never be reached behind the floor.
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('dashboardLayouts', {
				userId: 'user-E',
				rules: [],
				pinnedCards: [
					{ type: 'campaign_performance', size: 'medium' as const },
					{ type: 'agent_health', size: 'small' as const },
				],
				updatedAt: Date.now(),
			});
		});

		mockUserId = 'user-E';
		mockRole = 'editor';
		const result = await t.query(api.analytics.adaptiveDashboard.getLayout, {});
		// `agent_health` is an organization-operations card an editor may not see.
		expect(result.cards.map((c) => c.type)).toEqual(['campaign_performance']);
	});
});

describe('adaptiveDashboard.getRawLayout — auth', () => {
	it('throws when unauthenticated', async () => {
		const t = convexTest(schema, modules);
		mockUserId = null;
		await expect(t.query(api.analytics.adaptiveDashboard.getRawLayout, {})).rejects.toThrow(
			/Not authenticated/
		);
	});

	it('reads the session user’s row, never another user’s', async () => {
		const t = convexTest(schema, modules);
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

		mockUserId = 'user-A';
		const raw = await t.query(api.analytics.adaptiveDashboard.getRawLayout, {});
		expect(raw?.userId).toBe('user-A');
		expect(raw?.pinnedCards?.[0]?.type).toBe('queue_depth');
	});

	it('resolves the session ONCE — the row key comes from the floor', async () => {
		const t = convexTest(schema, modules);
		await t.query(api.analytics.adaptiveDashboard.getRawLayout, {});
		expect(vi.mocked(sessionOrganization.requireOrgMember)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(sessionOrganization.getUserIdFromSession)).not.toHaveBeenCalled();
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

	it('resolves the session ONCE — the write key comes from the floor', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(api.analytics.adaptiveDashboard.saveLayout, {
			rules: [],
			pinnedCards: [],
		});
		// `authedMutation`'s floor, and nothing on top of it.
		expect(vi.mocked(sessionOrganization.getMutationContext)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(sessionOrganization.getUserIdFromSession)).not.toHaveBeenCalled();
		expect(vi.mocked(sessionOrganization.getBetterAuthSessionWithRole)).not.toHaveBeenCalled();
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
		// all to filter a 13-element constant. The handler now reads the role off
		// the session `authedQuery`'s floor threads in, so the floor's own
		// `requireOrgMember` is the ONLY resolution — and the handler reaches for no
		// session helper of its own at all.
		const t = convexTest(schema, modules);
		await t.query(api.analytics.adaptiveDashboard.getAvailableCards, {});
		expect(vi.mocked(sessionOrganization.requireOrgMember)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(sessionOrganization.getBetterAuthSessionWithRole)).not.toHaveBeenCalled();
		expect(vi.mocked(sessionOrganization.getUserIdFromSession)).not.toHaveBeenCalled();
	});
});
