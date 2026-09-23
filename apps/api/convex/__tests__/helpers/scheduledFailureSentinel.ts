/**
 * Shared by the scheduled-failure sentinel, the gate that spawns it and the
 * in-process gate tests. Kept out of the test files so importing it never
 * registers their tests.
 */
import type { TestConvex } from 'convex-test';
import { internal } from '../../_generated/api';
import type schema from '../../schema';

export const SCHEDULED_SENTINEL_SWITCH = 'OWLAT_SCHEDULED_FAILURE_SENTINEL';

/** The function the sentinel makes throw, as convex-test names it. */
export const THROWING_FUNCTION = 'webhooks/deliveryReconciler:reconcileOverdueDeliveries';

/**
 * Schedule a real function with an argument its validator rejects, so it
 * throws when it runs, then drain the scheduler.
 */
export async function runThrowingScheduledFunction(t: TestConvex<typeof schema>): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.scheduler.runAfter(
			0,
			internal.webhooks.deliveryReconciler.reconcileOverdueDeliveries,
			{ unexpected: true } as never
		);
	});
	await t.finishAllScheduledFunctions(() => {});
}
