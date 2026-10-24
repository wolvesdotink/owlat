/**
 * Read on arrival: a finished history import starts the
 * 30-day interpretation backfill once, behind a durable marker, and never
 * undoes a cancellation, overrides a paused walk or touches a shared mailbox.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it } from 'vitest';
import schema from '../../../schema';
import type { Id } from '../../../_generated/dataModel';
import { modules, seedMailbox } from '../../__tests__/helpers.testlib';
import { startAutoBackfillAfterImport } from '../autoBackfill';

type T = TestConvex<typeof schema>;

async function setPreference(t: T, mailboxId: Id<'mailboxes'>, isReadOnArrival: boolean) {
	await t.run(async (ctx) => {
		const userId = (await ctx.db.get(mailboxId))!.userId;
		await ctx.db.insert('mailUserSettings', {
			userId,
			autoAdvance: 'next',
			isReadOnArrival,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

const jobOf = (t: T, mailboxId: Id<'mailboxes'>) =>
	t.run((ctx) =>
		ctx.db
			.query('interpretBackfillJobs')
			.withIndex('by_mailbox', (q) => q.eq('mailboxId', mailboxId))
			.first()
	);

const start = (t: T, mailboxId: Id<'mailboxes'>) =>
	t.run((ctx) => startAutoBackfillAfterImport(ctx, mailboxId));

describe('the automatic backfill after an import', () => {
	it('starts the walk once and marks the mailbox', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		expect(await start(t, mailboxId)).toBe('started');
		expect(await jobOf(t, mailboxId)).toMatchObject({ status: 'running' });
		const marker = await t.run(
			async (ctx) => (await ctx.db.get(mailboxId))!.interpretAutoBackfillAt
		);
		expect(marker).toEqual(expect.any(Number));
		// A second completion starts nothing.
		const job = (await jobOf(t, mailboxId))!;
		await t.run((ctx) => ctx.db.patch(job._id, { status: 'completed' }));
		expect(await start(t, mailboxId)).toBe('skipped');
		expect(await jobOf(t, mailboxId)).toMatchObject({ status: 'completed' });
	});

	it('does nothing with read on arrival off, and leaves no marker', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t);
		await setPreference(t, mailboxId, false);
		expect(await start(t, mailboxId)).toBe('skipped');
		expect(await jobOf(t, mailboxId)).toBeNull();
		const marker = await t.run(
			async (ctx) => (await ctx.db.get(mailboxId))!.interpretAutoBackfillAt
		);
		expect(marker ?? null).toBeNull();
	});

	it('never undoes a cancellation or a paused walk', async () => {
		for (const status of ['cancelled', 'paused'] as const) {
			const t = convexTest(schema, modules);
			const mailboxId = await seedMailbox(t);
			await t.run((ctx) =>
				ctx.db.insert('interpretBackfillJobs', {
					mailboxId,
					status,
					generation: 1,
					cutoffAt: 0,
					cursor: 'c',
					scannedCount: 3,
					threadCount: 3,
					messageCount: 3,
					runThreadCount: 3,
					startedAt: 1,
					updatedAt: 1,
				})
			);
			expect(await start(t, mailboxId)).toBe('marked');
			expect(await jobOf(t, mailboxId)).toMatchObject({ status, generation: 1 });
		}
	});

	it('leaves a shared mailbox alone', async () => {
		const t = convexTest(schema, modules);
		const mailboxId = await seedMailbox(t, { scope: 'shared' });
		expect(await start(t, mailboxId)).toBe('skipped');
		expect(await jobOf(t, mailboxId)).toBeNull();
	});
});
