import { describe, expect, it } from 'vitest';
import { internal } from '../_generated/api';
import { SCHEDULED_SENTINEL_SWITCH } from './helpers/scheduledFailureSentinel';
import { newHarness } from './testModules';

/**
 * Failures only the file-level check can catch: every test here passes, and
 * the file must still fail in `afterAll`. Skipped in every normal run;
 * `scheduledFailureGate.test.ts` spawns vitest on it with the switch set.
 */

/** Schedule the throwing function on real timers and return without draining. */
async function leakThrowingJob(delayMs: number): Promise<void> {
	await newHarness().run(async (ctx) => {
		await ctx.scheduler.runAfter(
			delayMs,
			internal.webhooks.deliveryReconciler.reconcileOverdueDeliveries,
			{ unexpected: true } as never
		);
	});
}

describe.skipIf(process.env[SCHEDULED_SENTINEL_SWITCH] !== '1')(
	'scheduled failure file sentinel',
	() => {
		it('leaky: leaves a throwing job behind', async () => {
			await leakThrowingJob(50);
		});

		it('innocent: runs while the leaked job throws', async () => {
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(true).toBe(true);
		});

		it('last: leaves a throwing job that fires after the file', async () => {
			await leakThrowingJob(300);
		});
	}
);
