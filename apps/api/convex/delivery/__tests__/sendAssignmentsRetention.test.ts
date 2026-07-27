/**
 * Retention for the experiment record (plan D16).
 *
 * `sendAssignments` is one row per recipient per send, so an unbounded table is
 * a design defect, not a housekeeping nicety. The sweep must be indexed,
 * bounded per tick, resumable across ticks, and must never touch a row inside
 * the 90-day window.
 */

import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { createTestSendAssignment } from '../../__tests__/factories';
import {
	SEND_ASSIGNMENT_CLEANUP_BATCH_SIZE,
	SEND_ASSIGNMENT_RETENTION_MS,
} from '../sendAssignments';

const rootGlob = import.meta.glob('../../**/*.*s');
const deliveryGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../delivery/'),
		mod,
	])
);
const modules = { ...rootGlob, ...deliveryGlob };

const NOW = 1_800_000_000_000;

function assignment(sendId: string, assignedAt: number) {
	return createTestSendAssignment({ organizationId: 'org_a', sendId, assignedAt });
}

// A failing assertion must not leak fake timers into the next test.
afterEach(() => {
	vi.useRealTimers();
});

describe('sendAssignments retention sweep', () => {
	it('retains 90 days and deletes only what is older', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'sendAssignments',
				assignment('ancient', NOW - SEND_ASSIGNMENT_RETENTION_MS - 86_400_000)
			);
			await ctx.db.insert(
				'sendAssignments',
				assignment('just_expired', NOW - SEND_ASSIGNMENT_RETENTION_MS - 1)
			);
			// Exactly at the boundary: still inside the window (strict `<` cutoff).
			await ctx.db.insert(
				'sendAssignments',
				assignment('boundary', NOW - SEND_ASSIGNMENT_RETENTION_MS)
			);
			await ctx.db.insert('sendAssignments', assignment('fresh', NOW - 1_000));
		});

		const result = await t.mutation(internal.delivery.sendAssignments.cleanupExpiredAssignments, {
			now: NOW,
		});
		expect(result.deleted).toBe(2);

		const remaining = await t.run(async (ctx) => ctx.db.query('sendAssignments').collect());
		expect(remaining.map((row) => row.sendId).sort()).toEqual(['boundary', 'fresh']);
	});

	it('is bounded per tick and resumes until the backlog drains', async () => {
		const t = convexTest(schema, modules);
		// `finishInProgressScheduledFunctions` only drains functions already
		// running; the sweep's `runAfter(0)` follow-up is still PENDING at that
		// point, so the resume would never execute and the assertion below would
		// pass vacuously. Fake timers + `finishAllScheduledFunctions(runAllTimers)`
		// actually advance the scheduler to the follow-up. Timers must be faked
		// BEFORE the first mutation so the scheduler sees the fake clock.
		vi.useFakeTimers();
		const total = SEND_ASSIGNMENT_CLEANUP_BATCH_SIZE + 25;
		await t.run(async (ctx) => {
			for (let index = 0; index < total; index += 1) {
				await ctx.db.insert(
					'sendAssignments',
					assignment(`old_${index}`, NOW - SEND_ASSIGNMENT_RETENTION_MS - 1_000 - index)
				);
			}
			await ctx.db.insert('sendAssignments', assignment('fresh', NOW - 1_000));
		});

		const first = await t.mutation(internal.delivery.sendAssignments.cleanupExpiredAssignments, {
			now: NOW,
		});
		expect(first.deleted).toBe(SEND_ASSIGNMENT_CLEANUP_BATCH_SIZE);
		expect(
			await t.run(async (ctx) => (await ctx.db.query('sendAssignments').collect()).length)
		).toBe(total + 1 - SEND_ASSIGNMENT_CLEANUP_BATCH_SIZE);

		// The tick came back full, so it rescheduled itself; drain the follow-up.
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		vi.useRealTimers();

		const remaining = await t.run(async (ctx) => ctx.db.query('sendAssignments').collect());
		expect(remaining.map((row) => row.sendId)).toEqual(['fresh']);
		// And the backlog really did drain through a SECOND tick, not one big one.
		const scheduled = await t.run(async (ctx) =>
			ctx.db.system.query('_scheduled_functions').collect()
		);
		// Exactly one follow-up tick was scheduled and it completed. Asserting
		// the length first matters: `[].every(...)` is vacuously true, so the
		// success check alone would pass even if nothing had been rescheduled.
		expect(scheduled).toHaveLength(1);
		expect(scheduled.every((job) => job.state.kind === 'success')).toBe(true);
	});

	it('does not reschedule when the tick comes back short', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'sendAssignments',
				assignment('old', NOW - SEND_ASSIGNMENT_RETENTION_MS - 1)
			);
		});

		await t.mutation(internal.delivery.sendAssignments.cleanupExpiredAssignments, { now: NOW });
		const scheduled = await t.run(async (ctx) =>
			ctx.db.system.query('_scheduled_functions').collect()
		);
		expect(scheduled).toHaveLength(0);
	});

	it('is a no-op on an empty table', async () => {
		const t = convexTest(schema, modules);
		const result = await t.mutation(internal.delivery.sendAssignments.cleanupExpiredAssignments, {
			now: NOW,
		});
		expect(result.deleted).toBe(0);
	});

	it('falls back to the real clock on a non-finite `now`', async () => {
		// A NaN `now` would make the cutoff NaN and every comparison false, so
		// the sweep would silently delete nothing forever.
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'sendAssignments',
				assignment('ancient', Date.now() - SEND_ASSIGNMENT_RETENTION_MS - 86_400_000)
			);
			await ctx.db.insert('sendAssignments', assignment('fresh', Date.now() - 1_000));
		});

		const result = await t.mutation(internal.delivery.sendAssignments.cleanupExpiredAssignments, {
			now: Number.NaN,
		});

		expect(result).toEqual({ deleted: 1 });
		const remaining = await t.run(async (ctx) => ctx.db.query('sendAssignments').collect());
		expect(remaining.map((row) => row.sendId)).toEqual(['fresh']);
	});

	it('is registered as a cron so retention actually runs', async () => {
		const fs = await import('node:fs/promises');
		// The delivery retention sweeps are registered as a group from a domain
		// module (same pattern as `plugins/cronRegistration.ts`); `crons.ts` owns
		// the schedule object and calls it. Assert BOTH halves, so neither the
		// registration nor the call into it can be dropped unnoticed.
		const registration = await fs.readFile(
			new URL('../cronRegistration.ts', import.meta.url),
			'utf8'
		);
		expect(registration).toContain('internal.delivery.sendAssignments.cleanupExpiredAssignments');
		const crons = await fs.readFile(new URL('../../crons.ts', import.meta.url), 'utf8');
		expect(crons).toContain('registerDeliveryRetentionCrons(crons)');
	});
});
