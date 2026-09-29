/**
 * `loadOrderedSteps` (automations/steps.ts) is the one full-list read of an
 * automation's steps. The walker, the funnel and the editor all read step
 * order through it, so it must return rows in `stepIndex` order even when they
 * were inserted out of order, with no in-memory sort at the call sites.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api, internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import {
	createTestAutomation,
	createTestAutomationStep,
	enableFeatures,
} from '../../__tests__/factories';
import { loadOrderedSteps } from '../steps';
import { walkerModules, type T } from './walkerHarness';

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../../lib/sessionOrganization');
	return {
		...actual,
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'user-owner', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('user-owner'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'user-owner', role: 'owner' }),
	};
});

const INSERT_ORDER = [2, 0, 3, 1];

/** Seed an automation whose steps are inserted in a scrambled stepIndex order. */
async function seedScrambled(t: T): Promise<Id<'automations'>> {
	return t.run(async (ctx) => {
		const automationId = await ctx.db.insert('automations', createTestAutomation());
		for (const stepIndex of INSERT_ORDER) {
			await ctx.db.insert(
				'automationSteps',
				createTestAutomationStep({ automationId, stepType: 'delay', stepIndex })
			);
		}
		// A second automation's steps must never leak into the first's list.
		const otherId = await ctx.db.insert('automations', createTestAutomation());
		await ctx.db.insert(
			'automationSteps',
			createTestAutomationStep({ automationId: otherId, stepType: 'delay', stepIndex: 0 })
		);
		return automationId;
	});
}

describe('loadOrderedSteps', () => {
	it('returns steps in stepIndex order when they were inserted out of order', async () => {
		const t = convexTest(schema, walkerModules);
		const automationId = await seedScrambled(t);

		const steps = await t.run((ctx) => loadOrderedSteps(ctx.db, automationId));

		expect(steps.map((s) => s.stepIndex)).toEqual([0, 1, 2, 3]);
		expect(steps.every((s) => s.automationId === automationId)).toBe(true);
	});

	it('returns an empty list for an automation without steps', async () => {
		const t = convexTest(schema, walkerModules);
		const automationId = await t.run((ctx) => ctx.db.insert('automations', createTestAutomation()));

		expect(await t.run((ctx) => loadOrderedSteps(ctx.db, automationId))).toEqual([]);
	});

	it('orders the steps of every reader that goes through it', async () => {
		const t = convexTest(schema, walkerModules);
		// The public readers run on `automationsQuery`, whose floor reads the flag.
		await enableFeatures(t, ['automations']);
		const automationId = await seedScrambled(t);

		const detail = await t.query(api.automations.automations.get, { automationId });
		expect(detail?.steps.map((s) => s.stepIndex)).toEqual([0, 1, 2, 3]);

		const related = await t.query(api.automations.automations.getWithRelations, {
			automationId,
		});
		expect(related?.steps.map((s) => s.stepIndex)).toEqual([0, 1, 2, 3]);

		const funnel = await t.query(api.automations.analytics.getStepAnalytics, { automationId });
		expect(funnel.map((s) => s.stepIndex)).toEqual([0, 1, 2, 3]);

		const legacy = await t.query(internal.automations.stepExecutorQueries.getAutomationSteps, {
			automationId,
		});
		expect(legacy.map((s) => s.stepIndex)).toEqual([0, 1, 2, 3]);
	});
});
