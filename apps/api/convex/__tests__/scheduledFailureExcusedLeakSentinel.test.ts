import { describe, expect, it } from 'vitest';
import { internal } from '../_generated/api';
import { expectScheduledFailure } from './helpers/scheduledFailures';
import { SCHEDULED_SENTINEL_SWITCH, THROWING_FUNCTION } from './helpers/scheduledFailureSentinel';
import { newHarness } from './testModules';

/**
 * A job that its test expected to throw, left undrained, fires during the next
 * test. The excuse follows the job, so nothing here may fail. Skipped in every
 * normal run; `scheduledFailureGate.test.ts` spawns vitest on it with the
 * switch set.
 */
describe.skipIf(process.env[SCHEDULED_SENTINEL_SWITCH] !== '1')(
	'scheduled failure excused-leak sentinel',
	() => {
		it('excuses the function it breaks and leaves the job behind', async () => {
			expectScheduledFailure(THROWING_FUNCTION);
			await newHarness().run(async (ctx) => {
				await ctx.scheduler.runAfter(
					50,
					internal.webhooks.deliveryReconciler.reconcileOverdueDeliveries,
					{ unexpected: true } as never
				);
			});
		});

		it('runs while that job throws', async () => {
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(true).toBe(true);
		});
	}
);
