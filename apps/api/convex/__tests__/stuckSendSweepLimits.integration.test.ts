/**
 * The lost-send sweep under real transaction read limits (#1208).
 *
 * A Send row can be as large as a Convex document: a transactional Send
 * carries its data variables, a campaign Send its personalized subject. These
 * tests fill both send tables, in both ranges the sweep reads (past the
 * deadline, and never attempted), with Sends of about 1 MB each, then run
 * `status`, the cron and the operator pass under a 6 MiB read limit, well
 * under Convex's 16 MiB. Each path has to bound what it reads by bytes, not
 * only by rows.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import {
	createTestCampaign,
	createTestContact,
	createTestEmailSend,
	createTestTopic,
} from './factories';
import { DAY, type T } from './helpers/sendCompletionFailures';
import { UNANCHORED_MIN_AGE_MS } from '../delivery/stuckSendSweep';

const enqueueAction = vi.fn().mockResolvedValue('work-1');
vi.mock('../delivery/workpool', () => ({
	campaignEmailPool: { enqueueAction },
	transactionalEmailPool: { enqueueAction },
}));

const modules = import.meta.glob('../**/*.*s');
const MiB = 1024 * 1024;
const T0 = Date.UTC(2026, 5, 1, 12, 0, 0);
/** Just under the 1 MiB document limit once the rest of the row is added. */
const LARGE = 1_000_000;
const PER_RANGE = 12;

beforeEach(() => {
	vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
	vi.useRealTimers();
});

type Rows = {
	campaignDue: Id<'emailSends'>[];
	campaignUnanchored: Id<'emailSends'>[];
	transactionalDue: Id<'transactionalSends'>[];
	transactionalUnanchored: Id<'transactionalSends'>[];
};

async function fill(t: T): Promise<Rows> {
	const { campaignId, contactId } = await t.run(async (ctx) => ({
		campaignId: await ctx.db.insert('campaigns', createTestCampaign({ status: 'sending' })),
		contactId: await ctx.db.insert('contacts', createTestContact()),
	}));
	const rows: Rows = {
		campaignDue: [],
		campaignUnanchored: [],
		transactionalDue: [],
		transactionalUnanchored: [],
	};
	for (let i = 0; i < PER_RANGE; i++) {
		for (const firstAttemptAt of [T0 + i, undefined]) {
			const campaignSend = await t.run(
				async (ctx) =>
					await ctx.db.insert(
						'emailSends',
						createTestEmailSend({
							campaignId,
							contactId,
							status: 'queued',
							providerMessageId: undefined,
							personalizedSubject: 's'.repeat(LARGE),
							firstAttemptAt,
						})
					)
			);
			const transactionalSend = await t.run(
				async (ctx) =>
					await ctx.db.insert('transactionalSends', {
						kind: 'transactional',
						email: 'person@example.com',
						status: 'queued',
						queuedAt: Date.now(),
						dataVariables: { blob: 'd'.repeat(LARGE) },
						firstAttemptAt,
					})
			);
			if (firstAttemptAt === undefined) {
				rows.campaignUnanchored.push(campaignSend);
				rows.transactionalUnanchored.push(transactionalSend);
			} else {
				rows.campaignDue.push(campaignSend);
				rows.transactionalDue.push(transactionalSend);
			}
		}
	}
	return rows;
}

function harness(): T {
	return convexTest({ schema, modules, transactionLimits: { bytesRead: 6 * MiB } }) as T;
}

async function statuses(t: T, ids: Array<Id<'emailSends'> | Id<'transactionalSends'>>) {
	// One read per transaction: the rows are near the document size limit.
	const result: Array<string | undefined> = [];
	for (const id of ids) result.push(await t.run(async (ctx) => (await ctx.db.get(id))?.status));
	return result;
}

describe('the lost-send sweep with Sends near the document size limit', () => {
	it('status counts every range page by page inside the read limit', async () => {
		const t = harness();
		await fill(t);
		vi.setSystemTime(T0 + 30 * DAY);
		for (const kind of ['campaign', 'transactional'] as const) {
			for (const range of ['due', 'unanchored'] as const) {
				let counted = 0;
				let pages = 0;
				let next: { cursor: string; asOf: number } | undefined;
				for (;;) {
					const page = await t.query(internal.delivery.stuckSendSweepAdmin.status, {
						kind,
						range,
						...next,
					});
					counted += page.counted;
					pages += 1;
					if (page.isDone || page.continueCursor === null) break;
					next = { cursor: page.continueCursor, asOf: page.asOf };
				}
				expect(counted, `${kind} ${range}`).toBe(PER_RANGE);
				// The byte budget, not the 100-row page size, ended each page.
				expect(pages, `${kind} ${range}`).toBeGreaterThan(1);
			}
		}
	});

	it("status keeps the first page's cutoff on every continuation", async () => {
		// A Convex cursor resumes only the query it came from, and the range's
		// cutoff is part of that query. convex-test does not check that, so this
		// pins it by what the range returns: a row that only enters the range
		// after the first page must not be counted by a continuation.
		const t = harness();
		await fill(t);
		const asOf = T0 + 30 * DAY;
		vi.setSystemTime(asOf);
		const first = await t.query(internal.delivery.stuckSendSweepAdmin.status, {
			kind: 'transactional',
			range: 'unanchored',
		});
		expect(first.asOf).toBe(asOf);
		expect(first.isDone).toBe(false);

		// An hour later a new Send is queued, still with no first attempt.
		vi.setSystemTime(asOf + 60 * 60 * 1000);
		await t.run(async (ctx) => {
			await ctx.db.insert('transactionalSends', {
				kind: 'transactional',
				email: 'later@example.com',
				status: 'queued',
				queuedAt: Date.now(),
			});
		});
		let counted = first.counted;
		let next = { cursor: first.continueCursor ?? '', asOf: first.asOf };
		for (;;) {
			const page = await t.query(internal.delivery.stuckSendSweepAdmin.status, {
				kind: 'transactional',
				range: 'unanchored',
				...next,
			});
			expect(page.asOf).toBe(asOf);
			counted += page.counted;
			if (page.isDone || page.continueCursor === null) break;
			next = { cursor: page.continueCursor, asOf: page.asOf };
		}
		expect(counted).toBe(PER_RANGE);

		await expect(
			t.query(internal.delivery.stuckSendSweepAdmin.status, {
				kind: 'transactional',
				range: 'unanchored',
				cursor: first.continueCursor ?? '',
			})
		).rejects.toThrow(/asOf/u);
	});

	it('the cron fails every due Send inside the read limit', async () => {
		const t = harness();
		const rows = await fill(t);
		vi.setSystemTime(T0 + 30 * DAY);
		await t.mutation(internal.delivery.stuckSendSweep.sweepLostSends, {});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(new Set(await statuses(t, [...rows.campaignDue, ...rows.transactionalDue]))).toEqual(
			new Set(['failed'])
		);
		expect(
			new Set(await statuses(t, [...rows.campaignUnanchored, ...rows.transactionalUnanchored]))
		).toEqual(new Set(['queued']));
	});

	it('the operator pass fails every old unanchored Send inside the read limit', async () => {
		const t = harness();
		const rows = await fill(t);
		vi.setSystemTime(T0 + 30 * DAY);
		await t.mutation(internal.delivery.stuckSendSweepAdmin.failUnanchoredLostSends, {
			createdBefore: T0 + 30 * DAY - UNANCHORED_MIN_AGE_MS,
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(
			new Set(await statuses(t, [...rows.campaignUnanchored, ...rows.transactionalUnanchored]))
		).toEqual(new Set(['failed']));
		expect(new Set(await statuses(t, [...rows.campaignDue, ...rows.transactionalDue]))).toEqual(
			new Set(['queued'])
		);
	});

	it('fails a campaign Send whose campaign, send job and siblings are all near the limit', async () => {
		// The heaviest `failLostSend`: campaign reconciliation reads the campaign,
		// its send job and two other Sends (a terminal one, and one still queued),
		// or re-reads the campaign to complete it. Seven ~0.95 MiB documents.
		for (const hasQueuedSibling of [true, false]) {
			const t = convexTest({
				schema,
				modules,
				transactionLimits: { bytesRead: 8 * MiB },
			}) as T;
			const sendId = await t
				.run(async (ctx) => {
					const campaignId = await ctx.db.insert(
						'campaigns',
						createTestCampaign({ status: 'sending', archiveHtmlContent: 'h'.repeat(LARGE) })
					);
					const contactId = await ctx.db.insert('contacts', createTestContact());
					const topicId = await ctx.db.insert('topics', createTestTopic());
					await ctx.db.insert('campaignSendJobs', {
						campaignId,
						phase: 'done',
						cursor: 'c'.repeat(LARGE),
						audience: { kind: 'topic', topicId },
						enqueuedCount: 3,
						totalCandidates: 3,
						startedAt: T0,
						updatedAt: T0,
					});
					return { campaignId, contactId };
				})
				.then(async ({ campaignId, contactId }) => {
					const big = (overrides: Record<string, unknown>) =>
						t.run(
							async (ctx) =>
								await ctx.db.insert(
									'emailSends',
									createTestEmailSend({
										campaignId,
										contactId,
										personalizedSubject: 's'.repeat(LARGE),
										...overrides,
									})
								)
						);
					await big({ status: 'sent' });
					if (hasQueuedSibling) await big({ status: 'queued', providerMessageId: 'mta-1' });
					return await big({ status: 'queued', providerMessageId: undefined, firstAttemptAt: T0 });
				});
			vi.setSystemTime(T0 + 30 * DAY);
			const result = await t.mutation(internal.delivery.stuckSendSweep.failLostSend, {
				sendRef: { kind: 'campaign', id: sendId },
				mode: 'deadline',
				cutoff: T0 + 1,
			});
			expect(result.isFailed, `queued sibling: ${hasQueuedSibling}`).toBe(true);
			vi.setSystemTime(T0);
		}
	});
});
