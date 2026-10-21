/**
 * The prerequisite for decision-driven autonomous input (the auto-send
 * contract): item coverage must be enforced. While any decision
 * verdict feeds auto-send, an admin cannot switch item coverage off. Today no
 * verdict feeds it, so the setting moves freely, as before.
 */

import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiTaskName } from '@owlat/shared/aiRouting';
import schema from '../schema';
import { api } from '../_generated/api';

const feeding = vi.hoisted(() => ({ tasks: [] as AiTaskName[] }));

vi.mock('../lib/decision/calibration', async (importActual) => ({
	...(await importActual<object>()),
	AUTO_SEND_VERDICT_TASKS: feeding.tasks,
}));
vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	const admin = { userId: 'test-user', role: 'owner', activeOrganizationId: 'org-1' };
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue(admin),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue(admin),
		requireAdminContext: vi.fn().mockResolvedValue(admin),
	};
});

const modules = import.meta.glob('../**/*.*s');

async function withCoverage(isItemCoverageEnforced: boolean) {
	const t = convexTest(schema, modules);
	await t.run((ctx) =>
		ctx.db.insert('agentConfig', {
			isAutoReplyEnabled: false,
			confidenceThreshold: 0.8,
			isItemCoverageEnforced,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		})
	);
	const read = async () =>
		(await t.run((ctx) => ctx.db.query('agentConfig').first()))?.isItemCoverageEnforced;
	return { t, read };
}

afterEach(() => {
	feeding.tasks.length = 0;
});

describe('item coverage as the prerequisite of decision-driven autonomy', () => {
	it('moves freely while no decision verdict feeds auto-send (today)', async () => {
		const { t, read } = await withCoverage(true);
		await t.mutation(api.agentConfigMutations.updateConfig, { isItemCoverageEnforced: false });
		expect(await read()).toBe(false);
	});

	it('cannot be switched off while a decision verdict feeds auto-send', async () => {
		feeding.tasks.push('mail.draft_quality');
		const { t, read } = await withCoverage(true);
		await expect(
			t.mutation(api.agentConfigMutations.updateConfig, { isItemCoverageEnforced: false })
		).rejects.toThrow(/item coverage is enforced/);
		expect(await read()).toBe(true);
		// Other settings, and switching it on, still save.
		await t.mutation(api.agentConfigMutations.updateConfig, { confidenceThreshold: 0.9 });
		await t.mutation(api.agentConfigMutations.updateConfig, { isItemCoverageEnforced: true });
		expect(await read()).toBe(true);
	});
});
