import type { TestConvex } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import { internal } from '../_generated/api';
import type schema from '../schema';
import { expectScheduledFailure } from './helpers/scheduledFailures';
import { SCHEDULED_SENTINEL_SWITCH, THROWING_FUNCTION } from './helpers/scheduledFailureSentinel';
import { newHarness } from './testModules';

/**
 * A job that its test expected to throw, left undrained, fires during the next
 * test. The excuse follows the job, so nothing here may fail. Skipped in every
 * normal run; `scheduledFailureGate.test.ts` spawns vitest on it with the
 * switch set.
 */

/** The harness the first test left its job on, for the second to run it. */
let leftBehind: TestConvex<typeof schema> | undefined;

describe.skipIf(process.env[SCHEDULED_SENTINEL_SWITCH] !== '1')(
	'scheduled failure excused-leak sentinel',
	() => {
		it('excuses the function it breaks and leaves the job behind', async () => {
			expectScheduledFailure(THROWING_FUNCTION);
			// On fake timers, so the job runs only when the next test moves the clock.
			vi.useFakeTimers();
			leftBehind = newHarness();
			await leftBehind.run(async (ctx) => {
				await ctx.scheduler.runAfter(
					50,
					internal.webhooks.deliveryReconciler.reconcileOverdueDeliveries,
					{ unexpected: true } as never
				);
			});
		});

		it('runs while that job throws', async () => {
			try {
				await leftBehind!.finishAllScheduledFunctions(vi.runAllTimers);
			} finally {
				vi.useRealTimers();
			}
			expect(true).toBe(true);
		});
	}
);
