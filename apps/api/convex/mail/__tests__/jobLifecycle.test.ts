/**
 * The shared read / start / cancel lifecycle of the resumable per-mailbox walks
 * (`mail/_jobLifecycle.ts`): attachment backfill, body-search backfill and the
 * retroactive filter run all go through it, so its guarantees are pinned here
 * once rather than per module.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
import schema from '../../schema';
import type { Id } from '../../_generated/dataModel';
import { cancelJob, readJob, startJob } from '../_jobLifecycle';
import { modules, seedMailbox } from './helpers.testlib';

async function seedFilter(
	t: TestConvex<typeof schema>,
	mailboxId: Id<'mailboxes'>
): Promise<Id<'mailFilters'>> {
	return t.run(async (ctx) => {
		const now = Date.now();
		return ctx.db.insert('mailFilters', {
			mailboxId,
			name: 'Invoices',
			isEnabled: true,
			priority: 0,
			conditions: [{ field: 'subject', op: 'contains', value: 'invoice' }],
			actions: [{ type: 'markRead' }],
			stopProcessing: false,
			createdAt: now,
			updatedAt: now,
		});
	});
}

function attachmentJob(mailboxId: Id<'mailboxes'>, schedule = vi.fn(async () => null)) {
	return {
		table: 'mailAttachmentBackfillJobs' as const,
		key: mailboxId,
		insertFields: { mailboxId, indexedCount: 0 },
		resetFields: { indexedCount: 0 },
		schedule,
	};
}

describe('mail/_jobLifecycle startJob', () => {
	it('inserts a running row and schedules the first batch', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		const schedule = vi.fn(async () => null);

		const result = await t.run((ctx) => startJob(ctx, attachmentJob(mailboxId, schedule)));

		expect(result).toEqual({ started: true });
		expect(schedule).toHaveBeenCalledTimes(1);
		const job = await t.run((ctx) =>
			readJob(ctx, { table: 'mailAttachmentBackfillJobs', key: mailboxId })
		);
		expect(job).toMatchObject({
			mailboxId,
			status: 'running',
			scannedCount: 0,
			indexedCount: 0,
		});
		expect(job?.cursor).toBeUndefined();
		expect(job?.startedAt).toBe(job?.updatedAt);
	});

	it('returns started:false on a double start and neither forks nor reschedules', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		const schedule = vi.fn(async () => null);

		await t.run((ctx) => startJob(ctx, attachmentJob(mailboxId, schedule)));
		// Simulate a walk in flight: a page scanned and a cursor stored.
		await t.run(async (ctx) => {
			const job = await readJob(ctx, { table: 'mailAttachmentBackfillJobs', key: mailboxId });
			if (!job) throw new Error('expected the first start to insert a job');
			await ctx.db.patch(job._id, { cursor: 'page-2', scannedCount: 40, indexedCount: 3 });
		});

		const second = await t.run((ctx) => startJob(ctx, attachmentJob(mailboxId, schedule)));

		expect(second).toEqual({ started: false });
		expect(schedule).toHaveBeenCalledTimes(1);
		const rows = await t.run((ctx) => ctx.db.query('mailAttachmentBackfillJobs').collect());
		expect(rows).toHaveLength(1);
		// The in-flight walk keeps its progress.
		expect(rows[0]).toMatchObject({ status: 'running', cursor: 'page-2', scannedCount: 40 });
	});

	it('a restart resets the counters, cursor and outcome on the same row', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		const jobId = await t.run(async (ctx) =>
			ctx.db.insert('mailBodySearchBackfillJobs', {
				mailboxId,
				mode: 'purge',
				status: 'failed',
				cursor: 'stale-cursor',
				scannedCount: 900,
				indexedCount: 120,
				startedAt: 1,
				updatedAt: 2,
				finishedAt: 2,
				errorMessage: 'boom',
			})
		);
		const schedule = vi.fn(async () => null);

		const result = await t.run((ctx) =>
			startJob(ctx, {
				table: 'mailBodySearchBackfillJobs',
				key: mailboxId,
				insertFields: { mailboxId, mode: 'index', indexedCount: 0 },
				resetFields: { mode: 'index', indexedCount: 0 },
				schedule,
			})
		);

		expect(result).toEqual({ started: true });
		expect(schedule).toHaveBeenCalledTimes(1);
		const rows = await t.run((ctx) => ctx.db.query('mailBodySearchBackfillJobs').collect());
		expect(rows).toHaveLength(1);
		const [job] = rows;
		if (!job) throw new Error('expected the restarted job row');
		expect(job._id).toBe(jobId);
		expect(job).toMatchObject({
			mailboxId,
			mode: 'index',
			status: 'running',
			scannedCount: 0,
			indexedCount: 0,
		});
		expect(job.cursor).toBeUndefined();
		expect(job.finishedAt).toBeUndefined();
		expect(job.errorMessage).toBeUndefined();
		expect(job.startedAt).toBeGreaterThan(2);
	});

	it('keys a filter run by filter, so two filters in one mailbox get two rows', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		const first = await seedFilter(t, mailboxId);
		const second = await seedFilter(t, mailboxId);
		const filterJob = (filterId: Id<'mailFilters'>) => ({
			table: 'mailFilterRunJobs' as const,
			key: filterId,
			insertFields: { mailboxId, filterId, matchedCount: 0 },
			resetFields: { matchedCount: 0 },
			schedule: async () => null,
		});

		expect(await t.run((ctx) => startJob(ctx, filterJob(first)))).toEqual({ started: true });
		expect(await t.run((ctx) => startJob(ctx, filterJob(second)))).toEqual({ started: true });

		const rows = await t.run((ctx) => ctx.db.query('mailFilterRunJobs').collect());
		expect(rows.map((row) => row.filterId).sort()).toEqual([first, second].sort());
		const job = await t.run((ctx) => readJob(ctx, { table: 'mailFilterRunJobs', key: second }));
		expect(job).toMatchObject({ filterId: second, mailboxId, matchedCount: 0 });
	});
});

describe('mail/_jobLifecycle cancelJob', () => {
	it('moves a running job to cancelled and stamps when it ended', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await t.run((ctx) => startJob(ctx, attachmentJob(mailboxId)));

		await t.run((ctx) => cancelJob(ctx, { table: 'mailAttachmentBackfillJobs', key: mailboxId }));

		const job = await t.run((ctx) =>
			readJob(ctx, { table: 'mailAttachmentBackfillJobs', key: mailboxId })
		);
		expect(job?.status).toBe('cancelled');
		expect(job?.finishedAt).toBe(job?.updatedAt);
	});

	it.each(['completed', 'failed', 'cancelled'] as const)(
		'leaves a %s job exactly as it ended',
		async (status) => {
			const t = convexTest(schema, modules);
			const mailboxId = await seedMailbox(t);
			const before = {
				mailboxId,
				status,
				scannedCount: 10,
				indexedCount: 4,
				startedAt: 1,
				updatedAt: 2,
				finishedAt: 2,
			};
			await t.run((ctx) => ctx.db.insert('mailAttachmentBackfillJobs', before));

			await t.run((ctx) => cancelJob(ctx, { table: 'mailAttachmentBackfillJobs', key: mailboxId }));

			const job = await t.run((ctx) =>
				readJob(ctx, { table: 'mailAttachmentBackfillJobs', key: mailboxId })
			);
			expect(job).toMatchObject(before);
		}
	);

	it('does nothing when the walk never ran', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);

		await t.run((ctx) => cancelJob(ctx, { table: 'mailAttachmentBackfillJobs', key: mailboxId }));

		expect(
			await t.run((ctx) => readJob(ctx, { table: 'mailAttachmentBackfillJobs', key: mailboxId }))
		).toBeNull();
	});
});
