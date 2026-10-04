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
import { createTestCampaign, createTestContact, createTestEmailSend } from './factories';
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
				let cursor: string | undefined;
				for (;;) {
					const page = await t.query(internal.delivery.stuckSendSweepAdmin.status, {
						kind,
						range,
						...(cursor !== undefined ? { cursor } : {}),
					});
					counted += page.counted;
					pages += 1;
					if (page.isDone || page.continueCursor === null) break;
					cursor = page.continueCursor;
				}
				expect(counted, `${kind} ${range}`).toBe(PER_RANGE);
				// The byte budget, not the 100-row page size, ended each page.
				expect(pages, `${kind} ${range}`).toBeGreaterThan(1);
			}
		}
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
});
