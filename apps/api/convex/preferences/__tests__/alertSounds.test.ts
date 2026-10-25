/**
 * The alert sounds' own write door (preferences/alertSounds). The assignment
 * and agent-question sounds belong to the Team inbox, so an instance with only
 * `inbox` on must be able to save them; each switch keeps the floor of the
 * alert it sounds for, and the door writes the three sound fields of the
 * caller's own row and nothing else.
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

// The sibling module globs in as `../alertSounds.ts`; convex-test resolves
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

describe('preferences.alertSounds.update', () => {
	it('saves the team alert sounds on a Team-inbox-only instance', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['inbox']);
		await t.mutation(api.preferences.alertSounds.update, { isAssignmentSoundOn: true });
		await t.mutation(api.preferences.alertSounds.update, { isQuestionSoundOn: true });
		expect(await t.query(api.mail.settings.get, {})).toEqual({
			autoAdvance: 'next',
			isAssignmentSoundOn: true,
			isQuestionSoundOn: true,
		});
		// The mail reading preferences keep their personal-mail floor there.
		await expect(
			t.mutation(api.mail.settings.update, { autoAdvance: 'back-to-list' })
		).rejects.toThrow(/postbox/);
	});

	it('refuses the reply sound without personal mail', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['inbox']);
		await expect(
			t.mutation(api.preferences.alertSounds.update, { isReplyAlertSoundOn: true })
		).rejects.toThrow(/postbox/);
		expect(await t.query(api.mail.settings.get, {})).toBeNull();
	});

	it('refuses the team sounds without the Team inbox', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		await t.mutation(api.preferences.alertSounds.update, { isReplyAlertSoundOn: true });
		await expect(
			t.mutation(api.preferences.alertSounds.update, { isAssignmentSoundOn: true })
		).rejects.toThrow(/inbox/);
		await expect(
			t.mutation(api.preferences.alertSounds.update, { isQuestionSoundOn: true })
		).rejects.toThrow(/inbox/);
		expect(await t.query(api.mail.settings.get, {})).toEqual({
			autoAdvance: 'next',
			isReplyAlertSoundOn: true,
		});
	});

	it('refuses everything on an instance with neither mail nor the Team inbox', async () => {
		const t = convexTest(schema, modules);
		await expect(t.mutation(api.preferences.alertSounds.update, {})).rejects.toThrow();
	});

	it('round-trips each switch without clobbering the others or the mail settings', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external', 'inbox']);
		await t.mutation(api.mail.settings.update, { isSendSoundOn: true, density: 'compact' });
		await t.mutation(api.preferences.alertSounds.update, { isReplyAlertSoundOn: true });
		await t.mutation(api.preferences.alertSounds.update, { isAssignmentSoundOn: true });
		await t.mutation(api.preferences.alertSounds.update, { isQuestionSoundOn: false });
		expect(await t.query(api.mail.settings.get, {})).toEqual({
			autoAdvance: 'next',
			density: 'compact',
			isSendSoundOn: true,
			isReplyAlertSoundOn: true,
			isAssignmentSoundOn: true,
			isQuestionSoundOn: false,
		});
		await t.mutation(api.preferences.alertSounds.update, { isReplyAlertSoundOn: false });
		expect(await t.query(api.mail.settings.get, {})).toMatchObject({
			isReplyAlertSoundOn: false,
			isAssignmentSoundOn: true,
		});
	});

	it('leaves the switches absent on a row that never set them', async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['mail.external']);
		await t.mutation(api.mail.settings.update, { isHidePreviewOn: true });
		const row = await t.query(api.mail.settings.get, {});
		expect(row?.isReplyAlertSoundOn).toBeUndefined();
		expect(row?.isAssignmentSoundOn).toBeUndefined();
		expect(row?.isQuestionSoundOn).toBeUndefined();
	});

	it("keeps one user's alert sounds out of another user's row", async () => {
		const t = convexTest(schema, modules);
		await enableFeatures(t, ['inbox']);
		await t.mutation(api.preferences.alertSounds.update, { isAssignmentSoundOn: true });

		sessionMocks.userId = 'user-B';
		expect(await t.query(api.mail.settings.get, {})).toBeNull();
		await t.mutation(api.preferences.alertSounds.update, { isQuestionSoundOn: true });
		expect(await t.query(api.mail.settings.get, {})).toEqual({
			autoAdvance: 'next',
			isQuestionSoundOn: true,
		});

		sessionMocks.userId = 'user-A';
		expect(await t.query(api.mail.settings.get, {})).toEqual({
			autoAdvance: 'next',
			isAssignmentSoundOn: true,
		});
	});
});
