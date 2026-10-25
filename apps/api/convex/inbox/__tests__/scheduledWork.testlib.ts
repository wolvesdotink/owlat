/**
 * Runs the background work a delivery scheduled (the agent pipeline) to
 * completion before the test goes on.
 *
 * Left running, that work races whatever the test does next. convex-test
 * decides whether an action's storage call opens its own transaction by asking
 * whether ANY transaction is open, so a `storage.delete` issued while a
 * scheduled mutation is running executes inside that mutation's transaction and
 * can vanish with it; and a workspace deletion that begins while a pipeline step
 * is in flight puts the write fence up under that step.
 *
 * The test installs fake timers before it ingests anything, so every job lands
 * on a fake timer that only this drain fires: nothing scheduled runs alongside
 * the test's own calls, and a job that throws still fails the test through the
 * scheduled-failure gate.
 */
import { vi } from 'vitest';

interface DrainableConvex {
	finishAllScheduledFunctions(advanceTimers: () => void): Promise<void>;
}

export async function drainScheduled(t: DrainableConvex): Promise<void> {
	if (!vi.isFakeTimers()) {
		throw new Error('drainScheduled needs fake timers installed before the work was scheduled');
	}
	await t.finishAllScheduledFunctions(vi.runAllTimers);
}
