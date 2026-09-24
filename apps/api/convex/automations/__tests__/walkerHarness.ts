/**
 * Shared convex-test fixture for driving the automation step walker end to end.
 *
 * Callers must `vi.mock('../../delivery/workpool', …)` themselves (mocks are
 * per test file) so the intake's enqueue is inert, and must run under
 * `vi.useFakeTimers()` so scheduled step executions fire only when the test
 * advances the clock.
 */

import type { TestConvex } from 'convex-test';
import { vi } from 'vitest';
import type schema from '../../schema';
import type { Doc, Id } from '../../_generated/dataModel';
import {
	createTestAutomation,
	createTestAutomationStep,
	createTestContact,
	createTestEmailTemplate,
	createTestInstanceSettings,
} from '../../__tests__/factories';
import { bumpAutomationStats, summarizeAutomationStats } from '../statShards';

// `import.meta.glob('../../**')` omits the directory chain it climbed through,
// so the sibling `automations/*` modules are missing. Merge a second glob rooted
// at `automations/` and re-prefix its keys to the same `../../`-relative form.
const rootGlob = import.meta.glob('../../**/*.*s');
const automationsGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../automations/'),
		mod,
	])
);
export const walkerModules = Object.fromEntries(
	Object.entries({ ...rootGlob, ...automationsGlob }).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('posthog') &&
			!path.includes('delivery/worker.ts') &&
			!path.includes('campaigns/testSend') &&
			!path.includes('delivery/workpool')
	)
);

export type T = TestConvex<typeof schema>;

export const DAY_MS = 24 * 60 * 60 * 1000;

type StepSpec = { email: string } | { delayDays: number };

export async function seedSettings(t: T): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert(
			'instanceSettings',
			createTestInstanceSettings({
				defaultFromEmail: 'noreply@example.com',
				defaultFromName: 'Owlat',
			})
		);
	});
}

/**
 * An ACTIVE automation whose steps are `specs` in order: `{ email: subject }` is
 * an email step with its own template, `{ delayDays }` a delay step.
 */
export async function seedAutomation(
	t: T,
	specs: StepSpec[]
): Promise<{ automationId: Id<'automations'>; stepIds: Id<'automationSteps'>[] }> {
	return await t.run(async (ctx) => {
		const automationId = await ctx.db.insert(
			'automations',
			createTestAutomation({ status: 'active' })
		);
		const stepIds: Id<'automationSteps'>[] = [];
		for (const [stepIndex, spec] of specs.entries()) {
			if ('email' in spec) {
				const templateId = await ctx.db.insert(
					'emailTemplates',
					createTestEmailTemplate({ subject: spec.email, htmlContent: '<p>Hello</p>' })
				);
				stepIds.push(
					await ctx.db.insert(
						'automationSteps',
						createTestAutomationStep({
							automationId,
							stepIndex,
							stepType: 'email',
							config: { emailTemplateId: templateId },
						})
					)
				);
			} else {
				stepIds.push(
					await ctx.db.insert(
						'automationSteps',
						createTestAutomationStep({
							automationId,
							stepIndex,
							stepType: 'delay',
							config: { duration: spec.delayDays, unit: 'days' },
						})
					)
				);
			}
		}
		return { automationId, stepIds };
	});
}

/** A contact and a `running` run for it, counted as entered like the trigger fanout does. */
export async function seedRun(
	t: T,
	automationId: Id<'automations'>,
	contactOverrides: Record<string, unknown> = {}
): Promise<{ runId: Id<'automationRuns'>; contactId: Id<'contacts'> }> {
	return await t.run(async (ctx) => {
		const contactId = await ctx.db.insert(
			'contacts',
			createTestContact({ email: 'reader@example.com', ...contactOverrides })
		);
		const runId = await ctx.db.insert('automationRuns', {
			automationId,
			contactId,
			currentStepIndex: 0,
			status: 'running',
			startedAt: Date.now(),
			triggeredBy: 'contact_created',
		});
		await bumpAutomationStats(ctx, automationId, { statsEntered: 1 });
		return { runId, contactId };
	});
}

/**
 * Fire every scheduled function due at the current (fake) time, including the
 * ones those schedule with no delay, and wait for all of them to finish.
 */
export async function runDueScheduled(t: T): Promise<void> {
	for (let round = 0; round < 25; round++) {
		vi.advanceTimersByTime(0);
		await t.finishInProgressScheduledFunctions();
	}
}

/** Advance the fake clock by `ms`, then run everything that became due. */
export async function advanceAndRun(t: T, ms: number): Promise<void> {
	vi.advanceTimersByTime(ms);
	await t.finishInProgressScheduledFunctions();
	await runDueScheduled(t);
}

export async function sends(t: T): Promise<Doc<'transactionalSends'>[]> {
	return await t.run(async (ctx) => ctx.db.query('transactionalSends').collect());
}

export async function stepRunsOf(
	t: T,
	runId: Id<'automationRuns'>
): Promise<Doc<'automationStepRuns'>[]> {
	return await t.run(async (ctx) =>
		ctx.db
			.query('automationStepRuns')
			.withIndex('by_automation_run', (q) => q.eq('automationRunId', runId))
			.collect()
	);
}

export async function runOf(t: T, runId: Id<'automationRuns'>): Promise<Doc<'automationRuns'>> {
	const run = await t.run(async (ctx) => ctx.db.get(runId));
	if (!run) throw new Error('run vanished');
	return run;
}

/** entered / completed / cancelled from the sharded counters. */
export async function runTotals(
	t: T,
	automationId: Id<'automations'>
): Promise<{ statsEntered: number; statsCompleted: number; statsCancelled: number }> {
	return await t.run(async (ctx) => summarizeAutomationStats(ctx.db, automationId));
}
