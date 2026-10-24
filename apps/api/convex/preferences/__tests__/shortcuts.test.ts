/**
 * The keyboard map's own write door (preferences/shortcuts). Shortcuts cover
 * every surface, so saving them must not depend on the personal-mail flags the
 * rest of the settings row is gated behind, and the door must write the two
 * keyboard fields of the caller's own row and nothing else.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';
import { enableFeatures } from '../../__tests__/factories';

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
			activeOrganizationId: 'org-1',
		})),
		getBetterAuthSessionWithRole: vi.fn(async () => ({
			userId: sessionMocks.userId,
			role: 'editor',
			activeOrganizationId: 'org-1',
		})),
	};
});

// The sibling module globs in as `../shortcuts.ts`; convex-test resolves
// function paths from the convex root, so re-root it.
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
				? (['../../preferences/' + key.slice(3), val] as const)
				: ([key, val] as const)
		)
);

beforeEach(() => {
	sessionMocks.userId = 'user-A';
});

describe('preferences.shortcuts.update', () => {
	it('saves the keyboard map on an instance without personal mail', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(api.preferences.shortcuts.update, {
			shortcutPreset: 'superhuman',
			shortcutOverrides: [{ id: 'global.settings', keys: ['mod+.'] }],
		});
		expect(await t.query(api.mail.settings.get, {})).toEqual({
			autoAdvance: 'next',
			shortcutPreset: 'superhuman',
			shortcutOverrides: [{ id: 'global.settings', keys: ['mod+.'] }],
		});
	});

	it('does not open the mail settings door on that instance', async () => {
		const t = convexTest(schema, modules);
		await expect(
			t.mutation(api.mail.settings.update, { autoAdvance: 'back-to-list' })
		).rejects.toThrow();
	});

	it('patches only the keyboard fields of an existing row', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		await t.mutation(api.mail.settings.update, { autoAdvance: 'previous', density: 'compact' });
		await t.mutation(api.preferences.shortcuts.update, { shortcutOverrides: [] });
		await t.mutation(api.preferences.shortcuts.update, { shortcutPreset: 'gmail' });
		expect(await t.query(api.mail.settings.get, {})).toEqual({
			autoAdvance: 'previous',
			density: 'compact',
			shortcutPreset: 'gmail',
			shortcutOverrides: [],
		});
	});

	it("is scoped per user: one person's map is invisible to another", async () => {
		const t = convexTest(schema, modules);
		await t.mutation(api.preferences.shortcuts.update, { shortcutPreset: 'outlook' });
		sessionMocks.userId = 'user-B';
		expect(await t.query(api.mail.settings.get, {})).toBeNull();
		await t.mutation(api.preferences.shortcuts.update, { shortcutPreset: 'gmail' });
		sessionMocks.userId = 'user-A';
		expect(await t.query(api.mail.settings.get, {})).toMatchObject({ shortcutPreset: 'outlook' });
	});

	it('rejects a preset outside the union', async () => {
		const t = convexTest(schema, modules);
		await expect(
			t.mutation(api.preferences.shortcuts.update, {
				shortcutPreset: 'vim' as unknown as 'gmail',
			})
		).rejects.toThrow();
	});

	it('refuses an oversized remap list or chord instead of storing it', async () => {
		const t = convexTest(schema, modules);
		const many = Array.from({ length: 201 }, (_, i) => ({ id: `global.x${i}`, keys: ['x'] }));
		await expect(
			t.mutation(api.preferences.shortcuts.update, { shortcutOverrides: many })
		).rejects.toThrow(/at most 200/);
		await expect(
			t.mutation(api.preferences.shortcuts.update, {
				shortcutOverrides: [{ id: 'global.settings', keys: ['x'.repeat(65)] }],
			})
		).rejects.toThrow(/at most 64/);
		await expect(
			t.mutation(api.preferences.shortcuts.update, {
				shortcutOverrides: [{ id: 'global.settings', keys: Array(11).fill('x') }],
			})
		).rejects.toThrow(/at most 10/);
		expect(await t.query(api.mail.settings.get, {})).toBeNull();
	});
});
