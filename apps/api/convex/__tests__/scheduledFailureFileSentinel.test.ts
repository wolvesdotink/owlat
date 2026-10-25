import type { TestConvex } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import { internal } from '../_generated/api';
import type schema from '../schema';
import { SCHEDULED_SENTINEL_SWITCH } from './helpers/scheduledFailureSentinel';
import { newHarness } from './testModules';

/**
 * Failures only the file-level check can catch: every test here passes, and
 * the file must still fail in `afterAll`. Skipped in every normal run;
 * `scheduledFailureGate.test.ts` spawns vitest on it with the switch set.
 */

/** Schedule the throwing function and return without draining; the harness is handed back. */
async function leakThrowingJob(delayMs: number): Promise<TestConvex<typeof schema>> {
	const t = newHarness();
	await t.run(async (ctx) => {
		await ctx.scheduler.runAfter(
			delayMs,
			internal.webhooks.deliveryReconciler.reconcileOverdueDeliveries,
			{ unexpected: true } as never
		);
	});
	return t;
}

/** The harness the leaky test left its job on, for the next test to run it. */
let leftBehind: TestConvex<typeof schema> | undefined;

describe.skipIf(process.env[SCHEDULED_SENTINEL_SWITCH] !== '1')(
	'scheduled failure file sentinel',
	() => {
		it('leaky: leaves a throwing job behind', async () => {
			// On fake timers, so the job runs only when the next test moves the clock.
			vi.useFakeTimers();
			leftBehind = await leakThrowingJob(50);
		});

		it('innocent: runs while the leaked job throws', async () => {
			try {
				await leftBehind!.finishAllScheduledFunctions(vi.runAllTimers);
			} finally {
				vi.useRealTimers();
			}
			expect(true).toBe(true);
		});

		it('last: leaves a throwing job that fires after the file', async () => {
			// On real timers, due after the file ends: only the gate's drain in
			// `afterAll` runs it.
			await leakThrowingJob(300);
		});
	}
);
