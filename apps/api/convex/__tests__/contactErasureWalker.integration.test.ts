import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { TestConvex } from 'convex-test';
import type schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import type { DatabaseReader } from '../_generated/server';
import { createTestContact } from './factories';
import { newHarness } from './testModules';
import { danglingContactReferences } from './helpers/contactErasure';
import { selectExpiredSoftDeletedContacts } from '../contacts/erasure/retention';
import { ERASURE_ROWS_PER_TRANSACTION } from '../contacts/erasure/walker';
import { ERASURE_READ_CHUNK } from '../contacts/erasure/budget';
import { bumpAutomationStats, summarizeAutomationStats } from '../automations/statShards';

/**
 * The soft-delete retention sweep and the erasure walker behind it.
 *
 * Selection must be an index range (the old post-filter read every live
 * contact before `take` could stop it), and one contact's erasure must be a
 * persisted walk of bounded transactions that survives a lost chain and
 * records its failures.
 */

type Harness = TestConvex<typeof schema>;

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

async function runScheduled(t: Harness): Promise<void> {
	await t.finishAllScheduledFunctions(vi.runAllTimers);
}

/** Cancel every pending scheduled function — the walker's chain "dies". */
async function killScheduledWork(t: Harness): Promise<void> {
	await t.run(async (ctx) => {
		const scheduled = await ctx.db.system.query('_scheduled_functions').collect();
		for (const fn of scheduled) {
			if (fn.state.kind === 'pending') await ctx.scheduler.cancel(fn._id);
		}
	});
}

async function jobFor(t: Harness, contactId: Id<'contacts'>) {
	return t.run((ctx) =>
		ctx.db
			.query('contactErasureJobs')
			.withIndex('by_contact', (q) => q.eq('contactId', contactId))
			.first()
	);
}

describe('retention selection', () => {
	it('reads only the expired interval through index bounds', async () => {
		const t = newHarness();
		const now = Date.now();
		const ids = await t.run(async (ctx) => {
			for (let i = 0; i < 300; i++) await ctx.db.insert('contacts', createTestContact({}));
			const expired: Id<'contacts'>[] = [];
			for (const age of [45, 60, 31]) {
				expired.push(
					await ctx.db.insert('contacts', createTestContact({ deletedAt: now - age * DAY }))
				);
			}
			// Soft-deleted, but still inside the 30-day grace.
			for (const age of [2, 29]) {
				await ctx.db.insert('contacts', createTestContact({ deletedAt: now - age * DAY }));
			}
			return expired;
		});

		const cutoff = now - 30 * DAY;
		const selected = await t.run((ctx) => selectExpiredSoftDeletedContacts(ctx.db, cutoff, 10));
		// Oldest first, and nothing live or still in grace.
		expect(selected.map((c) => c._id)).toEqual([ids[1], ids[0], ids[2]]);

		const limited = await t.run((ctx) => selectExpiredSoftDeletedContacts(ctx.db, cutoff, 2));
		expect(limited.map((c) => c._id)).toEqual([ids[1], ids[0]]);
	});

	it('expresses the interval as the index range, with no post-filter', async () => {
		const calls: string[] = [];
		const recorder = {
			gte: (field: string, value: unknown) => (calls.push(`gte ${field} ${value}`), recorder),
			lt: (field: string, value: unknown) => (calls.push(`lt ${field} ${value}`), recorder),
			gt: (field: string) => (calls.push(`gt ${field}`), recorder),
			lte: (field: string) => (calls.push(`lte ${field}`), recorder),
			eq: (field: string) => (calls.push(`eq ${field}`), recorder),
		};
		const query = {
			withIndex(name: string, range: (q: typeof recorder) => unknown) {
				calls.push(`index ${name}`);
				range(recorder);
				return query;
			},
			filter() {
				calls.push('filter');
				return query;
			},
			take: async () => [],
		};
		const db = { query: () => query } as unknown as DatabaseReader;

		await selectExpiredSoftDeletedContacts(db, 1_000, 5);
		expect(calls).toEqual(['index by_deleted_at', 'gte deletedAt 0', 'lt deletedAt 1000']);
	});

	it('the daily sweep starts one erasure per expired contact and none for the rest', async () => {
		const t = newHarness();
		const now = Date.now();
		const { expiredId, graceId, liveId } = await t.run(async (ctx) => ({
			expiredId: await ctx.db.insert('contacts', createTestContact({ deletedAt: now - 40 * DAY })),
			graceId: await ctx.db.insert('contacts', createTestContact({ deletedAt: now - 3 * DAY })),
			liveId: await ctx.db.insert('contacts', createTestContact({})),
		}));

		const first = await t.mutation(internal.contacts.contacts.cleanupSoftDeletedContacts, {});
		expect(first).toEqual({ started: 1, restarted: 0 });
		// Idempotent while the job is under way.
		const second = await t.mutation(internal.contacts.contacts.cleanupSoftDeletedContacts, {});
		expect(second).toEqual({ started: 0, restarted: 0 });

		await runScheduled(t);
		await t.run(async (ctx) => {
			expect(await ctx.db.get(expiredId)).toBeNull();
			expect(await ctx.db.get(graceId)).not.toBeNull();
			expect(await ctx.db.get(liveId)).not.toBeNull();
			expect(await ctx.db.query('contactErasureJobs').collect()).toHaveLength(0);
		});
	});
});

describe('erasure walker', () => {
	/** A contact with far more history than one transaction may touch. */
	async function seedHighHistoryContact(t: Harness) {
		return t.run(async (ctx) => {
			const now = Date.now();
			const contactId = await ctx.db.insert(
				'contacts',
				createTestContact({ email: 'long-history@example.com', deletedAt: now - 40 * DAY })
			);
			for (let i = 0; i < 700; i++) {
				await ctx.db.insert('contactActivities', {
					contactId,
					activityType: 'email_opened' as const,
					occurredAt: now - i,
				});
			}
			const campaignId = await ctx.db.insert('campaigns', {
				name: 'C',
				status: 'sent' as const,
				createdAt: now,
				updatedAt: now,
			});
			for (let i = 0; i < 300; i++) {
				await ctx.db.insert('emailSends', {
					campaignId,
					contactId,
					contactEmail: 'long-history@example.com',
					contactFirstName: 'Long',
					contactLastName: 'History',
					status: 'sent' as const,
					queuedAt: now,
				});
			}
			const automationId = await ctx.db.insert('automations', {
				name: 'A',
				triggerType: 'contact_created' as const,
				status: 'active' as const,
				createdAt: now,
				updatedAt: now,
			});
			const stepId = await ctx.db.insert('automationSteps', {
				automationId,
				stepIndex: 0,
				stepType: 'delay' as const,
				config: { duration: 1, unit: 'days' } as never,
				statPending: 1,
				createdAt: now,
				updatedAt: now,
			});
			const runId = await ctx.db.insert('automationRuns', {
				automationId,
				contactId,
				currentStepIndex: 0,
				status: 'running' as const,
				startedAt: now,
				triggeredBy: 'contact_created',
			});
			await bumpAutomationStats(ctx, automationId, { statsEntered: 1 });
			await ctx.db.insert('automationStepRuns', {
				automationRunId: runId,
				automationStepId: stepId,
				stepIndex: 0,
				stepType: 'delay' as const,
				status: 'pending' as const,
				scheduledAt: now,
				retryCount: 0,
			});
			const threadId = await ctx.db.insert('conversationThreads', {
				subject: 'S',
				normalizedSubject: 's',
				contactId,
				contactIdentifier: 'long-history@example.com',
				status: 'open' as const,
				messageCount: 60,
				lastMessageAt: now,
				firstMessageAt: now,
				createdAt: now,
			});
			for (let i = 0; i < 60; i++) {
				await ctx.db.insert('unifiedMessages', {
					threadId,
					channel: 'email' as const,
					direction: 'inbound' as const,
					contactId,
					content: JSON.stringify({ text: `message ${i}` }),
					status: 'received' as const,
					createdAt: now,
				});
			}
			await ctx.db.insert('clarificationMemory', {
				contactId,
				slotType: 'date',
				questionKey: 'date:when',
				questionText: 'When?',
				answerValue: 'Friday',
				source: 'agent' as const,
				answerCount: 1,
				useCount: 0,
				createdAt: now,
				updatedAt: now,
			});
			return { contactId, automationId, stepId };
		});
	}

	it('erases a high-history contact over several bounded transactions and resumes after its chain dies', async () => {
		const t = newHarness();
		const { contactId, automationId, stepId } = await seedHighHistoryContact(t);

		await t.mutation(internal.contacts.contacts.cleanupSoftDeletedContacts, {});
		const job = (await jobFor(t, contactId))!;
		expect(job.status).toBe('running');

		// Two transactions by hand: each stays inside its row budget (plus at
		// most one read chunk or scrub page of overshoot) and saves where it
		// stopped, and the contact is still there in between.
		const perTransactionCeiling = ERASURE_ROWS_PER_TRANSACTION + 128 + ERASURE_READ_CHUNK;
		let previousRows = 0;
		for (let i = 1; i <= 2; i++) {
			expect(await t.mutation(internal.contacts.erasure.walker.tick, { jobId: job._id })).toBe(
				'more'
			);
			const saved = (await jobFor(t, contactId))!;
			expect(saved.transactions).toBe(i);
			expect(saved.rowsProcessed - previousRows).toBeGreaterThan(0);
			expect(saved.rowsProcessed - previousRows).toBeLessThanOrEqual(perTransactionCeiling);
			previousRows = saved.rowsProcessed;
			expect(await t.run((ctx) => ctx.db.get(contactId))).not.toBeNull();
		}

		// The chain dies: the scheduled continuation never runs.
		await killScheduledWork(t);
		await runScheduled(t);
		const stalled = (await jobFor(t, contactId))!;
		expect(stalled.transactions).toBe(2);
		expect(await t.run((ctx) => ctx.db.get(contactId))).not.toBeNull();

		// The next daily sweep finds the quiet job and restarts it from its
		// saved position.
		vi.advanceTimersByTime(DAY);
		const sweep = await t.mutation(internal.contacts.contacts.cleanupSoftDeletedContacts, {});
		expect(sweep).toEqual({ started: 0, restarted: 1 });
		await runScheduled(t);

		await t.run(async (ctx) => {
			expect(await ctx.db.get(contactId)).toBeNull();
			expect(await ctx.db.query('contactErasureJobs').collect()).toHaveLength(0);
			expect(await danglingContactReferences(ctx, contactId)).toEqual([]);
			expect(await ctx.db.query('automationStepRuns').collect()).toHaveLength(0);

			const sends = await ctx.db
				.query('emailSends')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId))
				.collect();
			expect(sends).toHaveLength(300);
			for (const send of sends) {
				expect(send.contactEmail).toBe('[erased]');
				expect(send.contactFirstName).toBeUndefined();
				expect(send.deletedAt).toBeDefined();
			}

			const totals = await summarizeAutomationStats(ctx.db, automationId);
			expect(totals.statsEntered - totals.statsCompleted - totals.statsCancelled).toBe(0);
			expect((await ctx.db.get(stepId))?.statPending).toBe(0);
		});
	});

	it('records a failing transaction on the job, retries, gives up visibly and is re-armed', async () => {
		const t = newHarness();
		const { contactId } = await seedHighHistoryContact(t);
		await t.mutation(internal.contacts.contacts.cleanupSoftDeletedContacts, {});
		await killScheduledWork(t);
		const job = (await jobFor(t, contactId))!;

		// A corrupt saved cursor makes every transaction of this phase throw.
		await t.run((ctx) => ctx.db.patch(job._id, { phase: 'emailSends', cursor: 'not-a-cursor' }));

		await t.action(internal.contacts.erasure.walker.drive, { jobId: job._id });
		const failedOnce = (await jobFor(t, contactId))!;
		expect(failedOnce.status).toBe('retrying');
		expect(failedOnce.attempts).toBe(1);
		expect(failedOnce.lastError).toBeTruthy();
		expect(failedOnce.lastErrorAt).toBeDefined();
		// The failed transaction rolled back: the phase and cursor are intact.
		expect(failedOnce.phase).toBe('emailSends');
		expect(failedOnce.cursor).toBe('not-a-cursor');

		// Let the scheduled retries run out.
		await runScheduled(t);
		const gaveUp = (await jobFor(t, contactId))!;
		expect(gaveUp.status).toBe('failed');
		expect(gaveUp.attempts).toBe(5);
		expect(await t.run((ctx) => ctx.db.get(contactId))).not.toBeNull();

		// Fix the corruption; the next daily sweep re-arms the job and it
		// completes.
		await t.run((ctx) => ctx.db.patch(job._id, { cursor: undefined }));
		vi.advanceTimersByTime(DAY);
		const sweep = await t.mutation(internal.contacts.contacts.cleanupSoftDeletedContacts, {});
		expect(sweep.restarted).toBe(1);
		await runScheduled(t);
		expect(await t.run((ctx) => ctx.db.get(contactId))).toBeNull();
		expect(await jobFor(t, contactId)).toBeNull();
	});
});

describe('REST hard delete', () => {
	it('tombstones at once and finishes a large history in the background', async () => {
		const t = newHarness();
		const contactId = await t.run(async (ctx) => {
			const id = await ctx.db.insert(
				'contacts',
				createTestContact({ email: 'api-delete@example.com' })
			);
			await ctx.db.insert('contactIdentities', {
				contactId: id,
				channel: 'email',
				identifier: 'api-delete@example.com',
				isPrimary: true,
				createdAt: Date.now(),
			});
			for (let i = 0; i < 900; i++) {
				await ctx.db.insert('contactActivities', {
					contactId: id,
					activityType: 'email_opened' as const,
					occurredAt: i,
				});
			}
			return id;
		});

		await t.mutation(internal.contacts.contacts.removeForTeam, { contactId });
		await t.run(async (ctx) => {
			const contact = await ctx.db.get(contactId);
			// Hidden from every read and its address reclaimable immediately…
			expect(contact?.deletedAt).toBeDefined();
			expect(
				await ctx.db
					.query('contactIdentities')
					.withIndex('by_contact', (q) => q.eq('contactId', contactId))
					.collect()
			).toHaveLength(0);
		});
		expect((await jobFor(t, contactId))?.reason).toBe('api_delete');

		// …and gone once the walker has run.
		await runScheduled(t);
		expect(await t.run((ctx) => ctx.db.get(contactId))).toBeNull();
		expect(await t.run((ctx) => danglingContactReferences(ctx, contactId))).toEqual([]);
	});
});
