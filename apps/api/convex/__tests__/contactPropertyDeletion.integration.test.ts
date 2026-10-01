import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { convexTest, type TestConvex } from 'convex-test';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { createTestContact } from './factories';
import { modules } from './testModules';
import { openWorkspaceDeletionFence } from './helpers/workspaceDeletionFence';
import { PROPERTY_VALUES_PER_TRANSACTION } from '../contacts/propertyDeletion';

vi.mock('../lib/sessionOrganization', async () => {
	const { sessionOrganizationMock } = await import('./sessionOrganizationMock');
	return await sessionOrganizationMock();
});

/**
 * Deleting a contact property (#918). The old `remove` read and deleted the
 * whole value column in one transaction, so a property set on 100,000 contacts
 * needed 200,002 document reads and 100,001 writes at once, far past the
 * platform limits. Values now go in bounded batches from a durable job; these
 * tests run the chain under per-transaction limits sized to that batch, so a
 * batch that grew with the column would fail here.
 */

type Harness = TestConvex<typeof schema>;

const MINUTE = 60 * 1000;

/**
 * A harness whose every transaction may write one batch of values plus a few
 * bookkeeping rows, and read each of them twice (paginate, then delete), well
 * under the real ceilings. The whole column does not fit in one.
 */
function batchLimitedHarness(): Harness {
	return convexTest({
		schema,
		modules,
		transactionLimits: {
			documentsWritten: PROPERTY_VALUES_PER_TRANSACTION + 10,
			documentsRead: 2 * PROPERTY_VALUES_PER_TRANSACTION + 50,
		},
	});
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

async function seedProperty(t: Harness, key: string) {
	return t.run((ctx) =>
		ctx.db.insert('contactProperties', { key, label: key, type: 'string', createdAt: Date.now() })
	);
}

/** `count` contacts, each with a value for `propertyId`; seeded under the limits. */
async function seedValues(
	t: Harness,
	propertyId: Id<'contactProperties'>,
	count: number
): Promise<Id<'contacts'>[]> {
	const contactIds: Id<'contacts'>[] = [];
	for (let seeded = 0; seeded < count; seeded += 400) {
		const chunk = await t.run(async (ctx) => {
			const ids: Id<'contacts'>[] = [];
			for (let i = seeded; i < Math.min(count, seeded + 400); i++) {
				const contactId = await ctx.db.insert(
					'contacts',
					createTestContact({ email: `c${i}@example.com` })
				);
				await ctx.db.insert('contactPropertyValues', {
					contactId,
					propertyId,
					value: `v${i}`,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
				ids.push(contactId);
			}
			return ids;
		});
		contactIds.push(...chunk);
	}
	return contactIds;
}

async function valueCount(t: Harness, propertyId: Id<'contactProperties'>) {
	return t.run(
		async (ctx) =>
			(
				await ctx.db
					.query('contactPropertyValues')
					.withIndex('by_property', (q) => q.eq('propertyId', propertyId))
					.collect()
			).length
	);
}

async function jobFor(t: Harness, propertyId: Id<'contactProperties'>) {
	return t.run((ctx) =>
		ctx.db
			.query('contactPropertyDeletionJobs')
			.withIndex('by_property', (q) => q.eq('propertyId', propertyId))
			.first()
	);
}

async function runScheduled(t: Harness) {
	await t.finishAllScheduledFunctions(vi.runAllTimers, 1000);
}

describe('contacts.properties.remove', () => {
	it('deletes an empty property in the request itself', async () => {
		const t = batchLimitedHarness();
		const propertyId = await seedProperty(t, 'empty');

		expect(await t.mutation(api.contacts.properties.remove, { propertyId })).toBe('deleted');

		await t.run(async (ctx) => {
			expect(await ctx.db.get(propertyId)).toBeNull();
			expect(await ctx.db.query('contactPropertyDeletionJobs').collect()).toHaveLength(0);
			expect(await ctx.db.system.query('_scheduled_functions').collect()).toHaveLength(0);
		});
	});

	it('removes a column larger than one transaction in bounded batches, leaving other properties alone', async () => {
		const t = batchLimitedHarness();
		const propertyId = await seedProperty(t, 'doomed');
		const keptId = await seedProperty(t, 'kept');
		const total = 2 * PROPERTY_VALUES_PER_TRANSACTION + 500;
		const contactIds = await seedValues(t, propertyId, total);
		await t.run(async (ctx) => {
			for (const contactId of contactIds.slice(0, 20)) {
				await ctx.db.insert('contactPropertyValues', {
					contactId,
					propertyId: keptId,
					value: 'kept',
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
			}
		});

		// The request runs the first batch only; the column outlives it.
		expect(await t.mutation(api.contacts.properties.remove, { propertyId })).toBe('pending');
		expect(await valueCount(t, propertyId)).toBe(total - PROPERTY_VALUES_PER_TRANSACTION);
		const job = await jobFor(t, propertyId);
		expect(job).toMatchObject({ status: 'running', requestedBy: 'test-user' });

		// Pickers no longer offer it; the admin listing shows its progress.
		const live = await t.query(api.contacts.properties.listByOrganization, {});
		expect(live.map((property) => property.key)).toEqual(['kept']);
		const all = await t.query(api.contacts.properties.listByOrganization, {
			includePendingDeletion: true,
		});
		expect(all.find((property) => property._id === propertyId)?.deletion).toMatchObject({
			status: 'running',
			valuesDeleted: PROPERTY_VALUES_PER_TRANSACTION,
		});

		// Every scheduled transaction runs under the batch-sized limits.
		await runScheduled(t);

		await t.run(async (ctx) => {
			expect(await ctx.db.get(propertyId)).toBeNull();
			expect(await ctx.db.query('contactPropertyDeletionJobs').collect()).toHaveLength(0);
		});
		expect(await valueCount(t, propertyId)).toBe(0);
		expect(await valueCount(t, keptId)).toBe(20);
	});

	it('coalesces a repeated request onto the job under way', async () => {
		const t = batchLimitedHarness();
		const propertyId = await seedProperty(t, 'twice');
		await seedValues(t, propertyId, PROPERTY_VALUES_PER_TRANSACTION + 10);

		expect(await t.mutation(api.contacts.properties.remove, { propertyId })).toBe('pending');
		const first = await jobFor(t, propertyId);
		expect(await t.mutation(api.contacts.properties.remove, { propertyId })).toBe('pending');

		await t.run(async (ctx) => {
			const jobs = await ctx.db.query('contactPropertyDeletionJobs').collect();
			expect(jobs.map((job) => job._id)).toEqual([first!._id]);
			// Only the first request scheduled a chain.
			expect(await ctx.db.system.query('_scheduled_functions').collect()).toHaveLength(1);
		});
		await runScheduled(t);
		expect(await valueCount(t, propertyId)).toBe(0);
	});

	it('refuses value writes, same-key creates and label edits while the property is being deleted', async () => {
		const t = batchLimitedHarness();
		const propertyId = await seedProperty(t, 'closing');
		const keptId = await seedProperty(t, 'open');
		const [contactId] = await seedValues(t, propertyId, PROPERTY_VALUES_PER_TRANSACTION + 1);
		await t.mutation(api.contacts.properties.remove, { propertyId });

		await expect(
			t.mutation(api.contacts.propertyValues.bulkSet, {
				contactId: contactId!,
				values: [{ propertyId, value: 'again' }],
			})
		).rejects.toThrow(/being deleted/);
		await expect(
			t.mutation(api.contacts.properties.create, { key: 'closing', label: 'X', type: 'string' })
		).rejects.toThrow(/still being deleted/);
		await expect(
			t.mutation(api.contacts.properties.update, { propertyId, label: 'Renamed' })
		).rejects.toThrow(/being deleted/);

		// Unrelated contact writes carry on during the cleanup.
		await t.mutation(api.contacts.propertyValues.bulkSet, {
			contactId: contactId!,
			values: [{ propertyId: keptId, value: 'fine' }],
		});
		expect(await valueCount(t, keptId)).toBe(1);

		// An integration import neither writes the column nor re-registers the key.
		const outcome = await t.mutation(internal.contacts.import.importBatch, {
			rows: [{ email: 'c0@example.com', properties: { closing: 'x', open: 'y' } }],
			source: 'mailchimp',
			handleDuplicates: 'update',
		});
		expect(outcome.propertiesSkipped).toBe(1);
		expect(outcome.propertiesAutoRegistered).toBe(0);

		await runScheduled(t);
		expect(await valueCount(t, propertyId)).toBe(0);
		await t.run(async (ctx) => {
			expect(
				await ctx.db
					.query('contactProperties')
					.withIndex('by_key', (q) => q.eq('key', 'closing'))
					.collect()
			).toHaveLength(0);
		});
		// Once it is gone, a write for it fails cleanly instead of leaving an orphan.
		await expect(
			t.mutation(api.contacts.propertyValues.bulkSet, {
				contactId: contactId!,
				values: [{ propertyId, value: 'late' }],
			})
		).rejects.toThrow(/not found/i);
	});

	it('stops after repeated failures and resumes from the remaining values when re-armed', async () => {
		const t = batchLimitedHarness();
		const propertyId = await seedProperty(t, 'flaky');
		await seedValues(t, propertyId, PROPERTY_VALUES_PER_TRANSACTION + 300);
		await t.mutation(api.contacts.properties.remove, { propertyId });
		const job = (await jobFor(t, propertyId))!;

		// Five failed attempts, the last one a platform limit: the job gives up.
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		for (let i = 0; i < 4; i++) {
			await t.mutation(internal.contacts.propertyDeletion.recordFailure, {
				jobId: job._id,
				error: 'transient',
			});
		}
		await t.mutation(internal.contacts.propertyDeletion.recordFailure, {
			jobId: job._id,
			error: 'Wrote too many documents in a single function execution (limit: 16000).',
		});
		errorSpy.mockRestore();
		expect(await jobFor(t, propertyId)).toMatchObject({ status: 'failed', attempts: 5, rowCap: 1 });
		expect(await t.mutation(internal.contacts.propertyDeletion.tick, { jobId: job._id })).toBe(
			'stopped'
		);
		// The retries queued before it gave up find it stopped.
		await runScheduled(t);
		expect(await valueCount(t, propertyId)).toBe(300);

		// A repeated request re-arms it; it resumes a value at a time and widens.
		expect(await t.mutation(api.contacts.properties.remove, { propertyId })).toBe('pending');
		expect(await t.mutation(internal.contacts.propertyDeletion.tick, { jobId: job._id })).toBe(
			'more'
		);
		expect(await valueCount(t, propertyId)).toBe(299);
		expect(await jobFor(t, propertyId)).toMatchObject({
			status: 'running',
			attempts: 0,
			rowCap: 2,
		});
		await runScheduled(t);
		expect(await valueCount(t, propertyId)).toBe(0);
		expect(await jobFor(t, propertyId)).toBeNull();
	});

	/** The state a crashed chain leaves behind: marked, job running, nothing queued. */
	async function seedOrphanedJob(t: Harness, propertyId: Id<'contactProperties'>) {
		return await t.run(async (ctx) => {
			await ctx.db.patch(propertyId, { deletionRequestedAt: Date.now() });
			return await ctx.db.insert('contactPropertyDeletionJobs', {
				propertyId,
				requestedBy: 'test-user',
				status: 'running',
				valuesDeleted: 0,
				transactions: 0,
				attempts: 0,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});
	}

	it('restarts a job whose chain was lost', async () => {
		const t = batchLimitedHarness();
		const propertyId = await seedProperty(t, 'orphaned');
		await seedValues(t, propertyId, 1200);
		await seedOrphanedJob(t, propertyId);

		expect(await t.mutation(internal.contacts.propertyDeletion.resumeStalled, {})).toEqual({
			restarted: 0,
		});
		vi.advanceTimersByTime(31 * MINUTE);
		expect(await t.mutation(internal.contacts.propertyDeletion.resumeStalled, {})).toEqual({
			restarted: 1,
		});
		await runScheduled(t);
		await t.run(async (ctx) => {
			expect(await ctx.db.get(propertyId)).toBeNull();
			expect(await ctx.db.query('contactPropertyValues').collect()).toHaveLength(0);
		});
	});

	it('leaves a stalled job alone while a workspace deletion runs', async () => {
		const t = batchLimitedHarness();
		const propertyId = await seedProperty(t, 'orphaned');
		await seedValues(t, propertyId, 10);
		const jobId = await seedOrphanedJob(t, propertyId);
		// The deletion cancelled the chain and holds the fence over the job table.
		await t.run(openWorkspaceDeletionFence);
		vi.advanceTimersByTime(31 * MINUTE);
		const before = await t.run(async (ctx) => ctx.db.get(jobId));

		expect(await t.mutation(internal.contacts.propertyDeletion.resumeStalled, {})).toEqual({
			restarted: 0,
		});
		expect(await t.run(async (ctx) => ctx.db.get(jobId))).toEqual(before);
		expect(await valueCount(t, propertyId)).toBe(10);
	});
});
