/**
 * The routing policy's read and save (aiRouting/policy.ts): a missing row is
 * today's behaviour, saves are validated, compare-and-set and audited, and the
 * internal read every lane uses returns the same resolved policy.
 */

import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import { modules } from '../../mail/__tests__/helpers.testlib';
import { ROUTING_SWITCH_KEYS } from '@owlat/shared/aiRouting';

const ADMIN = vi.hoisted(() => ({
	userId: 'admin-1',
	role: 'owner' as const,
	activeOrganizationId: 'org-1',
}));

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireAdminContext: vi.fn().mockResolvedValue(ADMIN),
		requireOrgPermission: vi.fn().mockResolvedValue(ADMIN),
		getBetterAuthSessionWithRole: vi.fn().mockResolvedValue(ADMIN),
	};
});

afterEach(() => {
	vi.unstubAllEnvs();
});

function setup() {
	return convexTest(schema, modules);
}

describe('aiRouting.policy', () => {
	it('reads the defaults, which are today’s behaviour, when nothing was saved', async () => {
		const t = setup();
		const view = await t.query(api.aiRouting.policy.get, {});
		expect(view.isStored).toBe(false);
		expect(view.policy).toEqual(view.defaults);
		for (const key of ROUTING_SWITCH_KEYS) expect(view.policy[key], key).toBe('off');
		expect(view.policy.policyVersion).toBe(0);
		expect(view.shadowedSwitches).toEqual([]);
		expect(view.shadowAllowanceUsd).toBe(0);
		expect(view.shadowFractionMaxima).toEqual({
			shadowMaxMessageFraction: 0.1,
			shadowMaxCeilingFraction: 0.05,
		});
		expect(await t.query(internal.aiRouting.policy.getResolved, {})).toEqual(view.defaults);
	});

	it('saves a change, bumps the version and audits it', async () => {
		const t = setup();
		const saved = await t.mutation(api.aiRouting.policy.update, {
			expectedPolicyVersion: 0,
			earlyRuleArchive: 'enforce',
			knowledgeEntryCapPerMessage: 20,
			promptCacheTasks: ['mail.draft'],
		});
		expect(saved).toMatchObject({
			policyVersion: 1,
			earlyRuleArchive: 'enforce',
			knowledgeEntryCapPerMessage: 20,
			promptCacheTasks: ['mail.draft'],
		});
		expect(await t.query(internal.aiRouting.policy.getResolved, {})).toEqual(saved);

		const audits = await t.run((ctx) => ctx.db.query('auditLogs').collect());
		expect(audits).toHaveLength(1);
		expect(audits[0]).toMatchObject({
			userId: ADMIN.userId,
			action: 'ai_routing_policy.updated',
			resource: 'ai_routing_policy',
			details: {
				policyVersion: 1,
				changedFields: 'earlyRuleArchive,knowledgeEntryCapPerMessage,promptCacheTasks',
			},
		});
		expect(JSON.parse(audits[0]!.detailsBlob!)).toEqual({
			changes: {
				earlyRuleArchive: { from: 'off', to: 'enforce' },
				knowledgeEntryCapPerMessage: { from: null, to: 20 },
				promptCacheTasks: { from: [], to: ['mail.draft'] },
			},
		});
	});

	it('keeps absent fields and clears a cap passed as null', async () => {
		const t = setup();
		await t.mutation(api.aiRouting.policy.update, {
			expectedPolicyVersion: 0,
			verifyClaimCapPerMessage: 8,
			batchApi: 'enforce',
		});
		const next = await t.mutation(api.aiRouting.policy.update, {
			expectedPolicyVersion: 1,
			verifyClaimCapPerMessage: null,
		});
		expect(next).toMatchObject({
			policyVersion: 2,
			verifyClaimCapPerMessage: null,
			batchApi: 'enforce',
		});
		const row = await t.run((ctx) => ctx.db.query('aiRoutingPolicy').first());
		expect(row).not.toHaveProperty('verifyClaimCapPerMessage');
		expect(row?.updatedBy).toBe(ADMIN.userId);
	});

	it('refuses a save made against an older version', async () => {
		const t = setup();
		await t.mutation(api.aiRouting.policy.update, {
			expectedPolicyVersion: 0,
			attachmentGates: 'enforce',
		});
		await expect(
			t.mutation(api.aiRouting.policy.update, { expectedPolicyVersion: 0, batchApi: 'enforce' })
		).rejects.toThrow(/changed by someone else/);
	});

	it('writes nothing and audits nothing when the save changes nothing', async () => {
		const t = setup();
		const same = await t.mutation(api.aiRouting.policy.update, {
			expectedPolicyVersion: 0,
			earlyRuleArchive: 'off',
		});
		expect(same.policyVersion).toBe(0);
		expect(await t.run((ctx) => ctx.db.query('aiRoutingPolicy').first())).toBeNull();
		expect(await t.run((ctx) => ctx.db.query('auditLogs').collect())).toEqual([]);
	});

	it.each([
		['a fraction out of range', { triageAllowanceFraction: 1.5 }, /fraction/],
		['a message shadow share above 10%', { shadowMaxMessageFraction: 0.9 }, /at most 0.1/],
		['a ceiling shadow share above 5%', { shadowMaxCeilingFraction: 0.9 }, /at most 0.05/],
		['a non-positive shadow cap', { shadowCapUsd: 0 }, /shadowCapUsd/],
		['a cap that is not a whole number', { knowledgeEntryCapPerMessage: 2.5 }, /whole number/],
		[
			'a cache marker on a decision task',
			{ promptCacheTasks: ['mail.category' as const] },
			/language task/,
		],
	])('refuses %s', async (_label, patch, message) => {
		const t = setup();
		await expect(
			t.mutation(api.aiRouting.policy.update, { expectedPolicyVersion: 0, ...patch })
		).rejects.toThrow(message);
	});

	it('refuses to shadow without a daily ceiling or a shadow cap', async () => {
		const t = setup();
		vi.stubEnv('AI_SPEND_DAILY_BUDGET_USD', '0');
		await expect(
			t.mutation(api.aiRouting.policy.update, {
				expectedPolicyVersion: 0,
				categoryDisplayBundle: 'shadow',
			})
		).rejects.toThrow(/shadow spending cap/);
		const saved = await t.mutation(api.aiRouting.policy.update, {
			expectedPolicyVersion: 0,
			categoryDisplayBundle: 'shadow',
			shadowCapUsd: 2,
		});
		expect(saved.categoryDisplayBundle).toBe('shadow');
		const view = await t.query(api.aiRouting.policy.get, {});
		expect(view.shadowedSwitches).toEqual(['categoryDisplayBundle']);
		expect(view.shadowAllowanceUsd).toBe(2);
	});

	it('bounds the shadow allowance by the daily ceiling share when one is set', async () => {
		const t = setup();
		vi.stubEnv('AI_SPEND_DAILY_BUDGET_USD', '40');
		await t.mutation(api.aiRouting.policy.update, {
			expectedPolicyVersion: 0,
			clarifyNecessity: 'shadow',
		});
		const view = await t.query(api.aiRouting.policy.get, {});
		expect(view.dailyCeilingUsd).toBe(40);
		expect(view.shadowAllowanceUsd).toBeCloseTo(2);
	});
});
