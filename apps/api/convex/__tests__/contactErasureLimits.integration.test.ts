import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { convexTest, type TestConvex } from 'convex-test';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { createTestContact } from './factories';
import { modules } from './testModules';
import { isTransactionLimitError } from '../lib/convexLimitErrors';
import { startContactErasure } from '../contacts/erasure/walker';

/**
 * The contact-erasure walker against convex-test's enforced transaction limits:
 * a heavy history erases over several transactions without crossing them, and
 * a range too large for the deployment's limits cannot pin the job to one
 * checkpoint. Budget arithmetic is in `contactErasureByteBudget.test.ts`.
 */

type Harness = TestConvex<typeof schema>;

const KiB = 1024;
const MiB = 1024 * KiB;
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

/** A harness that enforces Convex's per-transaction limits (or tighter ones). */
function limitedHarness(limits: true | { bytesRead: number }): Harness {
	return convexTest({ schema, modules, transactionLimits: limits });
}

/** Tick `jobId` by hand until it is done; a tick that crosses a limit throws. */
async function tickToDone(t: Harness, jobId: Id<'contactErasureJobs'>) {
	const cursors: Array<string | undefined> = [];
	let outcome = 'more';
	while (outcome === 'more' && cursors.length < 200) {
		outcome = await t.mutation(internal.contacts.erasure.walker.tick, { jobId });
		cursors.push((await t.run((ctx) => ctx.db.get(jobId)))?.cursor);
	}
	expect(outcome).toBe('done');
	return cursors;
}

describe('walker under enforced platform limits', () => {
	async function runScheduled(t: Harness): Promise<void> {
		await t.finishAllScheduledFunctions(vi.runAllTimers);
	}

	/** A soft-deleted contact with a thread of `count` messages of `bytes` each. */
	async function seedMessageHistory(t: Harness, count: number, bytes: number) {
		const contactId = await t.run((ctx) =>
			ctx.db.insert(
				'contacts',
				createTestContact({ email: 'heavy@example.com', deletedAt: Date.now() - 40 * DAY })
			)
		);
		const threadId = await t.run((ctx) =>
			ctx.db.insert('conversationThreads', {
				subject: 'S',
				normalizedSubject: 's',
				contactId,
				contactIdentifier: 'heavy@example.com',
				status: 'open' as const,
				messageCount: count,
				lastMessageAt: Date.now(),
				firstMessageAt: Date.now(),
				createdAt: Date.now(),
			})
		);
		// A few per transaction: seeding is subject to the write limit too.
		for (let seeded = 0; seeded < count; seeded += 4) {
			await t.run(async (ctx) => {
				for (let i = seeded; i < Math.min(count, seeded + 4); i++) {
					await ctx.db.insert('unifiedMessages', {
						threadId,
						contactId,
						channel: 'email' as const,
						direction: 'inbound' as const,
						content: 'x'.repeat(bytes),
						status: 'received' as const,
						createdAt: Date.now(),
					});
				}
			});
		}
		const jobId = await t.run(async (ctx) => {
			await startContactErasure(ctx, contactId, 'retention');
			const job = await ctx.db
				.query('contactErasureJobs')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId))
				.first();
			return job!._id;
		});
		return { contactId, jobId };
	}

	it('erases a history of near-limit messages across transactions within the ceiling', async () => {
		const t = limitedHarness(true);
		const { contactId, jobId } = await seedMessageHistory(t, 24, 900 * KiB);

		let ticks = 0;
		let outcome = 'more';
		while (outcome === 'more' && ticks < 100) {
			// Throws if the transaction crosses a platform limit.
			outcome = await t.mutation(internal.contacts.erasure.walker.tick, { jobId });
			ticks += 1;
		}
		expect(outcome).toBe('done');
		expect(ticks).toBeGreaterThan(1);
		await t.run(async (ctx) => {
			expect(await ctx.db.get(contactId)).toBeNull();
			expect(await ctx.db.query('unifiedMessages').collect()).toHaveLength(0);
		});
	});

	it('crosses a range too large for the deployment a row at a time instead of pinning', async () => {
		// Below the budget's own allowance: the full-size transaction fails here.
		const t = limitedHarness({ bytesRead: 2 * MiB });
		const { contactId, jobId } = await seedMessageHistory(t, 10, 700 * KiB);

		await runScheduled(t);

		await t.run(async (ctx) => {
			expect(await ctx.db.get(contactId)).toBeNull();
			expect(await ctx.db.get(jobId)).toBeNull();
			expect(await ctx.db.query('unifiedMessages').collect()).toHaveLength(0);
		});
	});

	it('leaves a job that cannot fit one row failed, at one row, for the daily re-arm', async () => {
		const t = limitedHarness({ bytesRead: 512 * KiB });
		const { contactId, jobId } = await seedMessageHistory(t, 1, 700 * KiB);

		await runScheduled(t);
		const failed = (await t.run((ctx) => ctx.db.get(jobId)))!;
		expect(failed.status).toBe('failed');
		expect(failed.attempts).toBe(5);
		expect(failed.rowCap).toBe(1);
		expect(isTransactionLimitError(failed.lastError ?? '')).toBe(true);

		// Still visible and still retried: the sweep re-arms it at one row.
		vi.advanceTimersByTime(DAY);
		const sweep = await t.mutation(internal.contacts.contacts.cleanupSoftDeletedContacts, {});
		expect(sweep.restarted).toBe(1);
		await runScheduled(t);
		const again = (await t.run((ctx) => ctx.db.get(jobId)))!;
		expect(again.status).toBe('failed');
		expect(again.rowCap).toBe(1);
		expect(await t.run((ctx) => ctx.db.get(contactId))).not.toBeNull();
	});
});

describe('send scrubbing under enforced limits', () => {
	it('re-reads a page of heavy sends that Convex cut short instead of skipping past it', async () => {
		const t = limitedHarness(true);
		const contactId = await t.run((ctx) =>
			ctx.db.insert(
				'contacts',
				createTestContact({ email: 'heavy-send@example.com', deletedAt: Date.now() })
			)
		);
		const transactionalEmailId = await t.run((ctx) =>
			ctx.db.insert('transactionalEmails', {
				name: 'TX',
				slug: 'tx',
				subject: 'Hi',
				content: '[]',
				status: 'published' as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			})
		);
		for (let seeded = 0; seeded < 16; seeded += 4) {
			await t.run(async (ctx) => {
				for (let i = 0; i < 4; i++) {
					await ctx.db.insert('transactionalSends', {
						kind: 'transactional' as const,
						transactionalEmailId,
						contactId,
						email: 'heavy-send@example.com',
						status: 'sent' as const,
						dataVariables: { note: 'x'.repeat(600 * KiB) },
					});
				}
			});
		}
		const jobId = await t.run(async (ctx) => {
			await startContactErasure(ctx, contactId, 'retention');
			return (await ctx.db
				.query('contactErasureJobs')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId))
				.first())!._id;
		});

		const cursors = await tickToDone(t, jobId);
		expect(cursors.some((cursor) => cursor?.startsWith('narrow:'))).toBe(true);
		await t.run(async (ctx) => {
			expect(await ctx.db.get(contactId)).toBeNull();
			const sends = await ctx.db
				.query('transactionalSends')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId))
				.collect();
			expect(sends).toHaveLength(16);
			for (const send of sends) {
				expect(send.email).toBe('[erased]');
				expect(send.dataVariables).toBeUndefined();
			}
		});
	});

	it('erases an ordinary contact inside the REST delete that asked for it', async () => {
		const t = limitedHarness(true);
		const contactId = await t.run(async (ctx) => {
			const now = Date.now();
			const id = await ctx.db.insert('contacts', createTestContact({ email: 'rest@example.com' }));
			for (let i = 0; i < 50; i++) {
				await ctx.db.insert('contactActivities', {
					contactId: id,
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
			for (let i = 0; i < 100; i++) {
				await ctx.db.insert('emailSends', {
					campaignId,
					contactId: id,
					contactEmail: 'rest@example.com',
					status: 'sent' as const,
					queuedAt: now,
				});
			}
			const transactionalEmailId = await ctx.db.insert('transactionalEmails', {
				name: 'TX',
				slug: 'tx',
				subject: 'Hi',
				content: '[]',
				status: 'published' as const,
				createdAt: now,
				updatedAt: now,
			});
			for (let i = 0; i < 2; i++) {
				await ctx.db.insert('transactionalSends', {
					kind: 'transactional' as const,
					transactionalEmailId,
					contactId: id,
					email: 'rest@example.com',
					status: 'sent' as const,
				});
			}
			return id;
		});

		// No scheduled work runs: the first transaction inside the call does it all.
		await t.mutation(internal.contacts.contacts.removeForTeam, { contactId });
		await t.run(async (ctx) => {
			expect(await ctx.db.get(contactId)).toBeNull();
			expect(await ctx.db.query('contactErasureJobs').collect()).toHaveLength(0);
			const sends = await ctx.db
				.query('emailSends')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId))
				.collect();
			for (const send of sends) expect(send.contactEmail).toBe('[erased]');
		});
	});
});

describe('one paginated query per transaction', () => {
	it('stops at the second send table instead of paging it in the same transaction', async () => {
		const t = limitedHarness(true);
		const contactId = await t.run(async (ctx) => {
			const now = Date.now();
			const id = await ctx.db.insert('contacts', createTestContact({ email: 'both@example.com' }));
			const campaignId = await ctx.db.insert('campaigns', {
				name: 'C',
				status: 'sent' as const,
				createdAt: now,
				updatedAt: now,
			});
			const transactionalEmailId = await ctx.db.insert('transactionalEmails', {
				name: 'TX',
				slug: 'tx',
				subject: 'Hi',
				content: '[]',
				status: 'published' as const,
				createdAt: now,
				updatedAt: now,
			});
			// Both tables longer than a probe: each needs a page.
			for (let i = 0; i < 10; i++) {
				await ctx.db.insert('emailSends', {
					campaignId,
					contactId: id,
					contactEmail: 'both@example.com',
					status: 'sent' as const,
					queuedAt: now,
				});
				await ctx.db.insert('transactionalSends', {
					kind: 'transactional' as const,
					transactionalEmailId,
					contactId: id,
					email: 'both@example.com',
					status: 'sent' as const,
				});
			}
			return id;
		});

		// A second paginated query in one transaction throws in convex-test, as
		// it does on a deployment.
		await t.mutation(internal.contacts.contacts.removeForTeam, { contactId });
		const job = await t.run((ctx) =>
			ctx.db
				.query('contactErasureJobs')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId))
				.first()
		);
		expect(job?.phase).toBe('transactionalSends');
		await tickToDone(t, job!._id);
		await t.run(async (ctx) => {
			expect(await ctx.db.get(contactId)).toBeNull();
			for (const table of ['emailSends', 'transactionalSends'] as const) {
				const sends = await ctx.db
					.query(table)
					.withIndex('by_contact', (q) => q.eq('contactId', contactId))
					.collect();
				expect(sends).toHaveLength(10);
				for (const send of sends) {
					expect('contactEmail' in send ? send.contactEmail : send.email).toBe('[erased]');
				}
			}
		});
	});
});

describe('limit classification', () => {
	it('matches Convex per-transaction limit errors and nothing else', () => {
		expect(
			isTransactionLimitError(
				'Too many bytes read in a single function execution (limit: 16777216 bytes).'
			)
		).toBe(true);
		expect(
			isTransactionLimitError(
				'Read too much data in a single function execution (limit: 8388608 bytes). ' +
					'This is a Convex limit: https://docs.convex.dev/production/state/limits'
			)
		).toBe(true);
		// Transient or unrelated: a retry at the same size may clear these.
		expect(isTransactionLimitError('Request timed out')).toBe(false);
		expect(isTransactionLimitError('Your function ran for too long')).toBe(false);
		expect(isTransactionLimitError('Invalid cursor: not-a-cursor')).toBe(false);
	});
});
