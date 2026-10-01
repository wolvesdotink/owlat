import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { fireTrigger } from '../triggers';
import {
	createTestAutomation,
	createTestAutomationStep,
	createTestContact,
} from '../../__tests__/factories';
import { recordScans, type ScanRecord } from './indexScanRecorder';

const modules = import.meta.glob('../../**/*.*s');

// The guard is what is measured, not the walker it schedules.
const noScheduler = { runAfter: async () => null, runAt: async () => null, cancel: async () => {} };

function guardCtx(ctx: MutationCtx, log: ScanRecord[]): MutationCtx {
	return { ...recordScans(ctx, 'automationRuns', log), scheduler: noScheduler } as never;
}

async function seed(
	t: TestConvex<typeof schema>,
	history: number,
	running: boolean
): Promise<{ contactId: Id<'contacts'>; automationId: Id<'automations'> }> {
	return t.run(async (ctx) => {
		const contactId = await ctx.db.insert('contacts', createTestContact());
		const otherContactId = await ctx.db.insert('contacts', createTestContact());
		const automationId = await ctx.db.insert(
			'automations',
			createTestAutomation({ status: 'active', triggerType: 'contact_created' })
		);
		await ctx.db.insert(
			'automationSteps',
			createTestAutomationStep({ automationId, stepIndex: 0 })
		);
		const base = {
			automationId,
			currentStepIndex: 0,
			startedAt: 1,
			triggeredBy: 'contact_created',
		};
		for (let i = 0; i < history; i++) {
			await ctx.db.insert('automationRuns', {
				...base,
				contactId,
				status: i % 2 === 0 ? 'completed' : 'cancelled',
				completedAt: 2,
			});
		}
		// Another contact's live run on the same automation must not block this one.
		await ctx.db.insert('automationRuns', {
			...base,
			contactId: otherContactId,
			status: 'running',
		});
		if (running) await ctx.db.insert('automationRuns', { ...base, contactId, status: 'running' });
		return { contactId, automationId };
	});
}

async function runningCount(
	t: TestConvex<typeof schema>,
	automationId: Id<'automations'>,
	contactId: Id<'contacts'>
): Promise<number> {
	return t.run(
		async (ctx) =>
			(
				await ctx.db
					.query('automationRuns')
					.withIndex('by_automation_contact_status', (q) =>
						q.eq('automationId', automationId).eq('contactId', contactId).eq('status', 'running')
					)
					.collect()
			).length
	);
}

describe('trigger fanout running-instance guard', () => {
	it.each([0, 1, 1000])(
		'examines at most one run with %i completed/cancelled history rows',
		async (history) => {
			for (const running of [false, true]) {
				const t = convexTest(schema, modules);
				const { contactId, automationId } = await seed(t, history, running);
				const log: ScanRecord[] = [];

				const inserted = await t.run((ctx) =>
					fireTrigger(guardCtx(ctx, log), 'contact_created', { contactId })
				);

				expect(log).toHaveLength(1);
				expect(log[0]!.index).toBe('by_automation_contact_status');
				expect(log[0]!.postFilter).toEqual([]);
				// History never enters the scan: one row when a run is live, none otherwise.
				expect(log[0]!.examined).toBe(running ? 1 : 0);
				// Completed/cancelled history allows reentry; a live run blocks a second one.
				expect(inserted).toHaveLength(running ? 0 : 1);
				expect(await runningCount(t, automationId, contactId)).toBe(1);
			}
		},
		30_000
	);

	it('lets only one of two concurrent triggers start a run', async () => {
		const t = convexTest(schema, modules);
		const { contactId, automationId } = await seed(t, 10, false);

		const fire = () =>
			t.run((ctx) => fireTrigger(guardCtx(ctx, []), 'contact_created', { contactId }));
		const [a, b] = await Promise.all([fire(), fire()]);

		expect(a.length + b.length).toBe(1);
		expect(await runningCount(t, automationId, contactId)).toBe(1);
	});

	it('allows reentry after each run completes', async () => {
		const t = convexTest(schema, modules);
		const { contactId, automationId } = await seed(t, 0, false);
		const examined: number[] = [];

		for (let i = 0; i < 20; i++) {
			const log: ScanRecord[] = [];
			const [runId] = await t.run((ctx) =>
				fireTrigger(guardCtx(ctx, log), 'contact_created', { contactId })
			);
			expect(runId).toBeDefined();
			examined.push(log[0]!.examined);
			await t.run((ctx) => ctx.db.patch(runId!, { status: 'completed', completedAt: Date.now() }));
		}

		// The guard's cost stays flat as completed reentries pile up.
		expect(examined.every((n) => n === 0)).toBe(true);
		expect(await runningCount(t, automationId, contactId)).toBe(0);
	});
});
