/**
 * Retention for the experiment record (plan D16).
 *
 * `sendAssignments` is one row per recipient per send, so an unbounded table is
 * a design defect, not a housekeeping nicety. The sweep must be indexed,
 * bounded per tick, resumable across ticks, and must never touch a row inside
 * the 90-day window.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
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
	return {
		organizationId: 'org_a',
		sendId,
		sendKind: 'campaign' as const,
		cell: 'campaign:gmail',
		transport: 'mta',
		arm: 'own' as const,
		calibration: false,
		mixVersion: 0,
		assignedAt,
	};
}

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

		// The tick came back full, so it rescheduled itself; run the follow-up.
		await t.finishInProgressScheduledFunctions();

		const remaining = await t.run(async (ctx) => ctx.db.query('sendAssignments').collect());
		expect(remaining.map((row) => row.sendId)).toEqual(['fresh']);
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

	it('is registered as a cron so retention actually runs', async () => {
		const source = await import('node:fs/promises').then((fs) =>
			fs.readFile(new URL('../../crons.ts', import.meta.url), 'utf8')
		);
		expect(source).toContain('internal.delivery.sendAssignments.cleanupExpiredAssignments');
	});
});
