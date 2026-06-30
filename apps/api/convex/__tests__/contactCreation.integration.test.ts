/**
 * Integration tests for Contact creation (module).
 *
 * The created-effect bundle has one test surface: a `created` Contact fires
 * the trio (count + `contact_created` trigger + `created` activity carrying
 * `metadata.source`); a `matched` upsert fires none of them. The two
 * pre-module production bugs (count drift + silent trigger on the upsert
 * paths) are the regressions here.
 *
 * See docs/adr/0038-contact-creation-module.md.
 */

import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import { createTestAutomation, createTestAutomationStep } from './factories';

const incrementContactCountMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../lib/contactCountHelpers', async () => {
	const actual = await vi.importActual('../lib/contactCountHelpers');
	return {
		...actual,
		incrementContactCount: incrementContactCountMock,
		decrementContactCount: vi.fn().mockResolvedValue(undefined),
		getCachedContactCount: vi.fn().mockResolvedValue(0),
		reconcileContactCount: vi.fn().mockResolvedValue(undefined),
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(([path]) =>
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
);

async function createdActivities(
	t: ReturnType<typeof convexTest>,
	contactId: string,
) {
	return await t.run(async (ctx) => {
		const rows = await ctx.db.query('contactActivities').collect();
		return rows.filter(
			(row) => row.contactId === contactId && row.activityType === 'created',
		);
	});
}

describe('Contact creation (module) — a created Contact fires the trio', () => {
	it('increments the count, fires the contact_created trigger, and writes a created activity', async () => {
		const t = convexTest(schema, modules);
		incrementContactCountMock.mockClear();

		// Seed an active contact_created automation so the trigger has a run to create.
		await t.run(async (ctx) => {
			const automationId = await ctx.db.insert(
				'automations',
				createTestAutomation({ status: 'active', triggerType: 'contact_created' }),
			);
			await ctx.db.insert(
				'automationSteps',
				createTestAutomationStep({ automationId, stepIndex: 0 }),
			);
		});

		const result = await t.mutation(internal.contacts.creation.create, {
			channel: 'email',
			identifier: 'new@example.com',
			source: 'inbound',
			mode: 'upsert',
		});
		await t.finishInProgressScheduledFunctions();

		expect(result.action).toBe('created');

		// 1. count
		expect(incrementContactCountMock).toHaveBeenCalledTimes(1);

		// 2. trigger → one automation run
		const runs = await t.run((ctx) => ctx.db.query('automationRuns').collect());
		expect(runs).toHaveLength(1);
		expect(runs[0]!.triggeredBy).toBe('contact_created');

		// 3. created activity, tagged with the create source
		const created = await createdActivities(t, result.contactId);
		expect(created).toHaveLength(1);
		expect(created[0]!.metadata).toMatchObject({ source: 'inbound' });
	});
});

describe('Contact creation (module) — a matched upsert fires nothing', () => {
	it('a second upsert call returns matched and fires none of the trio', async () => {
		const t = convexTest(schema, modules);
		incrementContactCountMock.mockClear();

		await t.run(async (ctx) => {
			const automationId = await ctx.db.insert(
				'automations',
				createTestAutomation({ status: 'active', triggerType: 'contact_created' }),
			);
			await ctx.db.insert(
				'automationSteps',
				createTestAutomationStep({ automationId, stepIndex: 0 }),
			);
		});

		const first = await t.mutation(internal.contacts.creation.create, {
			channel: 'email',
			identifier: 'dup@example.com',
			source: 'inbound',
			mode: 'upsert',
		});
		const second = await t.mutation(internal.contacts.creation.create, {
			channel: 'email',
			identifier: 'dup@example.com',
			source: 'inbound',
			mode: 'upsert',
		});
		await t.finishInProgressScheduledFunctions();

		expect(first.action).toBe('created');
		expect(second.action).toBe('matched');
		expect(second.contactId).toBe(first.contactId);

		// Only the first (created) call fired the trio.
		expect(incrementContactCountMock).toHaveBeenCalledTimes(1);

		const runs = await t.run((ctx) => ctx.db.query('automationRuns').collect());
		expect(runs).toHaveLength(1);

		const created = await createdActivities(t, first.contactId);
		expect(created).toHaveLength(1);
	});
});

describe('Contact creation (module) — source propagation', () => {
	it('tags the created activity with the signal source', async () => {
		const t = convexTest(schema, modules);
		incrementContactCountMock.mockClear();

		const result = await t.mutation(internal.contacts.creation.create, {
			channel: 'email',
			identifier: 'formy@example.com',
			source: 'form',
			mode: 'strict',
		});

		const created = await createdActivities(t, result.contactId);
		expect(created).toHaveLength(1);
		expect(created[0]!.metadata).toMatchObject({ source: 'form' });
	});
});
