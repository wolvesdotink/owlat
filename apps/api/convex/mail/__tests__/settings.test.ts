/**
 * Per-user Postbox behavior preferences (mail/settings) — get/update
 * round-trip.
 *
 * The row is keyed by the session userId (no cross-user id is accepted),
 * so the tests swap the mocked session between users to assert isolation.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';

const sessionMocks = vi.hoisted(() => ({
	userId: 'user-A',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn(async () => ({ userId: sessionMocks.userId, role: 'editor' })),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getMutationContext: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: 'editor',
		})),
		getBetterAuthSessionWithRole: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: 'editor',
			activeOrganizationId: 'org-1',
		})),
	};
});

// Sibling `mail/*` modules glob in as `../foo.ts` (this file lives in
// `mail/__tests__/`); convex-test resolves function paths from the convex
// root, so re-root them to `../../mail/foo.ts`.
const allModules = import.meta.glob('../../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules)
		.filter(
			([path]) =>
				!path.includes('sesActions') &&
				!path.includes('agentSecurity') &&
				!path.includes('agentContext') &&
				!path.includes('agentClassifier') &&
				!path.includes('agentDrafter') &&
				!path.includes('agentRouter') &&
				!path.includes('agent/walker') &&
				!path.includes('agent/steps/index') &&
				!path.includes('agent/steps/shared') &&
				!path.includes('agent/steps/classify') &&
				!path.includes('agent/steps/draft') &&
				!path.includes('knowledgeExtraction') &&
				!path.includes('semanticFileProcessing') &&
				!path.includes('visualizationAgent') &&
				!path.includes('llmProvider')
		)
		.map(([key, val]) =>
			key.startsWith('../') && !key.startsWith('../../')
				? (['../../mail/' + key.slice(3), val] as const)
				: ([key, val] as const)
		)
);

beforeEach(() => {
	sessionMocks.userId = 'user-A';
});

describe('mail.settings get/update', () => {
	it('returns null before the user ever saved a preference', async () => {
		const t = convexTest(schema, modules);
		expect(await t.query(api.mail.settings.get, {})).toBeNull();
	});

	it('round-trips: update inserts a row that get returns', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(api.mail.settings.update, { autoAdvance: 'previous' });
		expect(await t.query(api.mail.settings.get, {})).toEqual({
			autoAdvance: 'previous',
		});
	});

	it('updates in place: a second update patches the same row', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(api.mail.settings.update, { autoAdvance: 'previous' });
		await t.mutation(api.mail.settings.update, { autoAdvance: 'back-to-list' });
		expect(await t.query(api.mail.settings.get, {})).toEqual({
			autoAdvance: 'back-to-list',
		});
		const rows = await t.run((ctx) => ctx.db.query('mailUserSettings').take(10));
		expect(rows).toHaveLength(1);
		expect(rows[0]?.userId).toBe('user-A');
	});

	it('round-trips the inbox view mode without clobbering other preferences', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(api.mail.settings.update, { autoAdvance: 'previous' });
		await t.mutation(api.mail.settings.update, { viewMode: 'categories' });
		expect(await t.query(api.mail.settings.get, {})).toEqual({
			autoAdvance: 'previous',
			viewMode: 'categories',
		});
	});

	it('rejects a view mode outside the union', async () => {
		const t = convexTest(schema, modules);
		await expect(
			t.mutation(api.mail.settings.update, {
				viewMode: 'stacked' as unknown as 'flat',
			})
		).rejects.toThrow();
	});

	it('rejects values outside the mode union', async () => {
		const t = convexTest(schema, modules);
		await expect(
			t.mutation(api.mail.settings.update, {
				autoAdvance: 'sideways' as unknown as 'next',
			})
		).rejects.toThrow();
	});

	it("is scoped per user: one user's preference is invisible to another", async () => {
		const t = convexTest(schema, modules);
		await t.mutation(api.mail.settings.update, { autoAdvance: 'previous' });

		sessionMocks.userId = 'user-B';
		expect(await t.query(api.mail.settings.get, {})).toBeNull();

		await t.mutation(api.mail.settings.update, { autoAdvance: 'back-to-list' });
		expect(await t.query(api.mail.settings.get, {})).toEqual({
			autoAdvance: 'back-to-list',
		});

		sessionMocks.userId = 'user-A';
		expect(await t.query(api.mail.settings.get, {})).toEqual({
			autoAdvance: 'previous',
		});
	});
});
