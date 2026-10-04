import { defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * The lost-send sweep's pass leases (#1208, `delivery/stuckSendSweep.ts`).
 *
 * One row per pass kind: a send table and a mode (`emailSends:deadline`,
 * `transactionalSends:unanchored`, ...). A pass holds its row while its page
 * chain runs, so the hourly cron does not start a second pass over the same
 * range while the first is still scheduling, and a superseded chain stops at
 * its next page. `generation` names the pass that owns the row; `isActive`
 * clears when its last page is done; `heartbeatAt` is stamped by every page, so
 * a chain that died is taken over once it has been quiet for the stale window.
 * Operational state only: no Send ids, no contact data.
 */
export const lostSendSweepTables = {
	lostSendSweepLeases: defineTable({
		pass: v.string(),
		generation: v.number(),
		isActive: v.boolean(),
		cutoff: v.number(),
		startedAt: v.number(),
		heartbeatAt: v.number(),
	}).index('by_pass', ['pass']),
};
