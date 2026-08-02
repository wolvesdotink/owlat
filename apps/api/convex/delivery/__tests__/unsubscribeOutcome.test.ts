/**
 * The `unsubscribed` transport outcome — the emitter (plan D5/D10).
 *
 * Three claims, and the third is the reason the piece exists:
 *
 *   1. a processed one-click unsubscribe reaches the (cell, arm) counter
 *      THROUGH THE REAL WRITER — the public endpoint's mutation, the scheduled
 *      attribution, the lifecycle effect runner and the assignment join, with
 *      nothing stubbed in between;
 *   2. it counts ONCE per send, however many times the link is exercised;
 *   3. with that counter written, the STANDALONE gate 3 reaches a verdict on
 *      the same traffic where it previously held at `insufficient_data`
 *      forever — a hold that outranks `pass` and froze the standalone ramp.
 *
 * The pure event→counter map lives in `analytics/__tests__/
 * transportOutcomesEvents.test.ts`; the gate cascade in `ramp/__tests__/`.
 */

import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { DatabaseWriter } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import type { DeliverabilityCellKey } from '@owlat/shared/deliverabilityRouting';
import { modules } from '../../__tests__/testModules';
import { createTestContact, createTestTopic } from '../../__tests__/factories';
import { startOfDayUtc } from '../../lib/clock';
import { summarizeTransportOutcomes } from '../../analytics/transportOutcomes';
import { ZERO_TRANSPORT_OUTCOME_TOTALS } from '../../analytics/transportOutcomeSummary';
import {
	bucketRow,
	DAY_MS,
	GMAIL_CAMPAIGN_CELL,
	MICROSOFT_CAMPAIGN_CELL,
	OUTCOME_ORG,
	readBuckets,
	seedAssignedSend,
	sumCounters,
	uniqueBucketKeys,
} from '../../analytics/__tests__/transportOutcomesFixtures';
import { ATTRIBUTION_LOOKBACK_SENDS } from '../marketingSendAttribution';
import { evaluateStandaloneComplaintGate } from '../ramp/trailingBaselineGates';
import { input, NOW } from '../ramp/__tests__/gateFixtures';

// The singleton-org lookup goes through the BetterAuth component, which is not
// registered in the convex-test harness. Same override the sibling outcome and
// assignment suites use, so the recorder's org resolution is deterministic.
vi.mock('../../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/sessionOrganization')>();
	// The literal, not the `OUTCOME_ORG` import: `vi.mock` factories are hoisted
	// above the imports, so referencing one here is a TDZ error at load time.
	return { ...actual, getSingletonOrganizationId: vi.fn().mockResolvedValue('org_outcomes') };
});

// The attribution is SCHEDULED off the synchronous unsubscribe path, so the
// end-to-end cases drive the clock to drain it (alongside the campaign-stats
// bump and the webhook fanout scheduled beside it).
afterEach(() => vi.useRealTimers());

/** A topic the seeded contact is a member of — the thing an unsubscribe removes. */
async function joinTopic(ctx: { db: DatabaseWriter }, contactId: Id<'contacts'>): Promise<void> {
	const topicId = await ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: false }));
	await ctx.db.insert('contactTopics', { contactId, topicId, addedAt: Date.now() });
}

async function seedContact(ctx: { db: DatabaseWriter }): Promise<Id<'contacts'>> {
	return await ctx.db.insert('contacts', createTestContact());
}

/**
 * A NON-CAMPAIGN send for a contact, with an assignment row when the case needs
 * the recorder to be able to reach a counter through it.
 */
async function seedNonCampaignSend(
	ctx: { db: DatabaseWriter },
	options: {
		contactId: Id<'contacts'>;
		kind: 'automation' | 'transactional' | 'test';
		cell?: DeliverabilityCellKey;
		status?: 'queued' | 'delivered';
	}
): Promise<Id<'transactionalSends'>> {
	const sendId = await ctx.db.insert('transactionalSends', {
		kind: options.kind,
		email: 'recipient@example.com',
		contactId: options.contactId,
		status: options.status ?? 'delivered',
		queuedAt: Date.now(),
		providerType: 'mta',
	});
	if (options.cell !== undefined) {
		await ctx.db.insert('sendAssignments', {
			organizationId: OUTCOME_ORG,
			sendId,
			sendKind: 'transactional',
			cell: options.cell,
			transport: 'mta',
			arm: 'own',
			isCalibration: false,
			mixVersion: 0,
			assignedAt: Date.now(),
		});
	}
	return sendId;
}

describe('a processed one-click unsubscribe reaches the (cell, arm) counter', () => {
	it('records `unsubscribed` end to end, through the public endpoint mutation', async () => {
		vi.useFakeTimers();
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'> | undefined;
		let sendId: Id<'emailSends'> | undefined;
		await t.run(async (ctx) => {
			const seeded = await seedAssignedSend(ctx, { status: 'delivered', assignment: {} });
			await joinTopic(ctx, seeded.contactId);
			contactId = seeded.contactId;
			sendId = seeded.sendId;
		});
		if (!contactId || !sendId) throw new Error('seed failed');
		const attributedSendId = sendId;

		const result = await t.mutation(internal.delivery.unsubscribeQueries.processUnsubscribe, {
			contactId,
		});
		expect(result).toEqual({ success: true, alreadyUnsubscribed: false, listsRemoved: 1 });
		await t.finishAllScheduledFunctions(() => vi.runAllTimers());

		await t.run(async (ctx) => {
			const buckets = await readBuckets(ctx);
			expect(uniqueBucketKeys(buckets)).toHaveLength(1);
			expect(buckets[0]?.organizationId).toBe(OUTCOME_ORG);
			expect(buckets[0]?.cell).toBe(GMAIL_CAMPAIGN_CELL);
			expect(buckets[0]?.arm).toBe('own');
			expect(sumCounters(buckets)).toEqual({
				...ZERO_TRANSPORT_OUTCOME_TOTALS,
				unsubscribed: 1,
			});
			// The uniqueness gate, on the send the unsubscribe was attributed to.
			expect((await ctx.db.get(attributedSendId))?.unsubscribedAt).toBeGreaterThan(0);
		});
	});

	it('follows the assignment on the send: a reference-arm send counts against `reference`', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'> | undefined;
		await t.run(async (ctx) => {
			const seeded = await seedAssignedSend(ctx, {
				status: 'delivered',
				assignment: { arm: 'reference', cell: MICROSOFT_CAMPAIGN_CELL },
			});
			contactId = seeded.contactId;
		});
		if (!contactId) throw new Error('seed failed');

		await t.mutation(internal.delivery.unsubscribeOutcome.recordUnsubscribeOutcome, {
			contactId,
		});
		await t.run(async (ctx) => {
			const buckets = await readBuckets(ctx);
			expect(buckets[0]?.cell).toBe(MICROSOFT_CAMPAIGN_CELL);
			expect(buckets[0]?.arm).toBe('reference');
			expect(sumCounters(buckets)).toEqual({
				...ZERO_TRANSPORT_OUTCOME_TOTALS,
				unsubscribed: 1,
			});
		});
	});

	it('attributes an unsubscribe from an automation drip to that drip', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'> | undefined;
		await t.run(async (ctx) => {
			contactId = await seedContact(ctx);
			await seedNonCampaignSend(ctx, {
				contactId,
				kind: 'automation',
				cell: MICROSOFT_CAMPAIGN_CELL,
			});
		});
		if (!contactId) throw new Error('seed failed');

		expect(
			await t.mutation(internal.delivery.unsubscribeOutcome.recordUnsubscribeOutcome, {
				contactId,
			})
		).toBe('recorded');
		await t.run(async (ctx) => {
			const buckets = await readBuckets(ctx);
			expect(buckets[0]?.cell).toBe(MICROSOFT_CAMPAIGN_CELL);
			expect(sumCounters(buckets)).toEqual({
				...ZERO_TRANSPORT_OUTCOME_TOTALS,
				unsubscribed: 1,
			});
		});
	});

	// Attribution is the most recent marketing send ACROSS both tables, so the
	// two candidates have to be ordered against each other — the cells differ
	// here precisely so a wrong winner lands in a visibly wrong bucket.
	it('picks the newer of the campaign and automation candidates', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'> | undefined;
		await t.run(async (ctx) => {
			contactId = await seedContact(ctx);
			await seedNonCampaignSend(ctx, {
				contactId,
				kind: 'automation',
				cell: MICROSOFT_CAMPAIGN_CELL,
			});
		});
		if (!contactId) throw new Error('seed failed');
		// Inserted after the drip, so the campaign send is the newer candidate.
		await t.run(async (ctx) => {
			await seedAssignedSend(ctx, {
				contactId,
				status: 'delivered',
				assignment: { cell: GMAIL_CAMPAIGN_CELL },
			});
		});

		await t.mutation(internal.delivery.unsubscribeOutcome.recordUnsubscribeOutcome, {
			contactId,
		});
		await t.run(async (ctx) => {
			expect((await readBuckets(ctx))[0]?.cell).toBe(GMAIL_CAMPAIGN_CELL);
		});
	});

	// THE NEXT CAMPAIGN'S BACKLOG. `delivery/sends.createBatch` pre-creates the
	// whole audience in `queued`, and the `sendAssignments` row that carries the
	// cell is written later, inside the scheduled enqueue transaction. A newest-
	// row-wins attribution would answer an unsubscribe with a message nobody has
	// received yet: it would stamp the undispatched row, record nothing, and —
	// the stamp being the gate — the delivered send that produced the signal
	// would never be reconsidered. The numerator would lose events precisely
	// during a blast.
	it('skips rows no transport has been handed and counts against the delivered send', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'> | undefined;
		let queuedSendId: Id<'emailSends'> | undefined;
		let failedSendId: Id<'emailSends'> | undefined;
		await t.run(async (ctx) => {
			const delivered = await seedAssignedSend(ctx, {
				status: 'delivered',
				assignment: { cell: GMAIL_CAMPAIGN_CELL },
			});
			contactId = delivered.contactId;
			// Both inserted after it, so a newest-row-wins join picks one of them.
			failedSendId = (
				await seedAssignedSend(ctx, {
					contactId,
					status: 'failed',
					assignment: { cell: MICROSOFT_CAMPAIGN_CELL },
				})
			).sendId;
			queuedSendId = (
				await seedAssignedSend(ctx, {
					contactId,
					status: 'queued',
					assignment: { cell: MICROSOFT_CAMPAIGN_CELL },
				})
			).sendId;
		});
		if (!contactId || !queuedSendId || !failedSendId) throw new Error('seed failed');
		const [queued, failed] = [queuedSendId, failedSendId];

		expect(
			await t.mutation(internal.delivery.unsubscribeOutcome.recordUnsubscribeOutcome, {
				contactId,
			})
		).toBe('recorded');

		await t.run(async (ctx) => {
			const buckets = await readBuckets(ctx);
			expect(uniqueBucketKeys(buckets)).toHaveLength(1);
			expect(buckets[0]?.cell).toBe(GMAIL_CAMPAIGN_CELL);
			expect(sumCounters(buckets)).toEqual({
				...ZERO_TRANSPORT_OUTCOME_TOTALS,
				unsubscribed: 1,
			});
			// Neither undispatched row absorbed the gate, so the next campaign's
			// own unsubscribes remain attributable once it is actually sent.
			expect((await ctx.db.get(queued))?.unsubscribedAt).toBeUndefined();
			expect((await ctx.db.get(failed))?.unsubscribedAt).toBeUndefined();
		});
	});

	// Same rule on the other table: a drip still sitting in the workpool queue is
	// not the message being answered.
	it('skips an undispatched automation drip', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'> | undefined;
		await t.run(async (ctx) => {
			contactId = await seedContact(ctx);
			await seedNonCampaignSend(ctx, {
				contactId,
				kind: 'automation',
				cell: GMAIL_CAMPAIGN_CELL,
				status: 'queued',
			});
		});
		if (!contactId) throw new Error('seed failed');

		expect(
			await t.mutation(internal.delivery.unsubscribeOutcome.recordUnsubscribeOutcome, {
				contactId,
			})
		).toBe('no_marketing_send');
		await t.run(async (ctx) => {
			expect(await readBuckets(ctx)).toHaveLength(0);
		});
	});
});

describe('one unsubscribe per send, however often the link is exercised', () => {
	it('counts a redelivered one-click POST once', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'> | undefined;
		await t.run(async (ctx) => {
			const seeded = await seedAssignedSend(ctx, { status: 'delivered', assignment: {} });
			contactId = seeded.contactId;
		});
		if (!contactId) throw new Error('seed failed');

		expect(
			await t.mutation(internal.delivery.unsubscribeOutcome.recordUnsubscribeOutcome, {
				contactId,
			})
		).toBe('recorded');
		expect(
			await t.mutation(internal.delivery.unsubscribeOutcome.recordUnsubscribeOutcome, {
				contactId,
			})
		).toBe('already_attributed');

		await t.run(async (ctx) => {
			expect(sumCounters(await readBuckets(ctx))).toEqual({
				...ZERO_TRANSPORT_OUTCOME_TOTALS,
				unsubscribed: 1,
			});
		});
	});

	// The gate has to survive a full round trip through the product, not just a
	// repeated POST: without the per-send stamp the numerator would outrun the
	// `delivered` denominator it is divided by.
	it('counts once when a contact re-subscribes and leaves the same send again', async () => {
		vi.useFakeTimers();
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'> | undefined;
		await t.run(async (ctx) => {
			const seeded = await seedAssignedSend(ctx, { status: 'delivered', assignment: {} });
			await joinTopic(ctx, seeded.contactId);
			contactId = seeded.contactId;
		});
		if (!contactId) throw new Error('seed failed');

		await t.mutation(internal.delivery.unsubscribeQueries.processUnsubscribe, { contactId });
		await t.finishAllScheduledFunctions(() => vi.runAllTimers());
		await t.run(async (ctx) => {
			await joinTopic(ctx, contactId!);
		});
		await t.mutation(internal.delivery.unsubscribeQueries.processUnsubscribe, { contactId });
		await t.finishAllScheduledFunctions(() => vi.runAllTimers());

		await t.run(async (ctx) => {
			expect(sumCounters(await readBuckets(ctx))).toEqual({
				...ZERO_TRANSPORT_OUTCOME_TOTALS,
				unsubscribed: 1,
			});
		});
	});
});

describe('what may never enter the arm denominators', () => {
	it('records nothing for an operator-initiated removal', async () => {
		vi.useFakeTimers();
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'> | undefined;
		await t.run(async (ctx) => {
			const seeded = await seedAssignedSend(ctx, { status: 'delivered', assignment: {} });
			await joinTopic(ctx, seeded.contactId);
			contactId = seeded.contactId;
		});
		if (!contactId) throw new Error('seed failed');

		await t.mutation(internal.topics.subscription.unsubscribeAllForContact, {
			contactId,
			source: 'admin',
		});
		await t.finishAllScheduledFunctions(() => vi.runAllTimers());

		await t.run(async (ctx) => {
			expect(await readBuckets(ctx)).toHaveLength(0);
		});
	});

	// Seeded WITH an assignment row on purpose: the exclusion has to be the
	// send's kind, not the unrelated fact that a preview usually has no cell.
	it('does not attribute an unsubscribe to a member-only test preview', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'> | undefined;
		await t.run(async (ctx) => {
			contactId = await seedContact(ctx);
			await seedNonCampaignSend(ctx, { contactId, kind: 'test', cell: GMAIL_CAMPAIGN_CELL });
		});
		if (!contactId) throw new Error('seed failed');

		expect(
			await t.mutation(internal.delivery.unsubscribeOutcome.recordUnsubscribeOutcome, {
				contactId,
			})
		).toBe('no_marketing_send');
		await t.run(async (ctx) => {
			expect(await readBuckets(ctx)).toHaveLength(0);
		});
	});

	// The bound exists so a contact with a long transactional history cannot turn
	// one unsubscribe into an unbounded read of a table nothing prunes.
	it('stops looking for a drip buried under later transactional mail', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'> | undefined;
		await t.run(async (ctx) => {
			contactId = await seedContact(ctx);
			await seedNonCampaignSend(ctx, {
				contactId,
				kind: 'automation',
				cell: GMAIL_CAMPAIGN_CELL,
			});
			for (let i = 0; i < ATTRIBUTION_LOOKBACK_SENDS; i += 1) {
				await seedNonCampaignSend(ctx, { contactId, kind: 'transactional' });
			}
		});
		if (!contactId) throw new Error('seed failed');

		expect(
			await t.mutation(internal.delivery.unsubscribeOutcome.recordUnsubscribeOutcome, {
				contactId,
			})
		).toBe('no_marketing_send');
		await t.run(async (ctx) => {
			expect(await readBuckets(ctx)).toHaveLength(0);
		});
	});

	it('records nothing for a send with no assignment row, and still stamps it', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'> | undefined;
		let sendId: Id<'emailSends'> | undefined;
		await t.run(async (ctx) => {
			const seeded = await seedAssignedSend(ctx, { status: 'delivered' });
			contactId = seeded.contactId;
			sendId = seeded.sendId;
		});
		if (!contactId || !sendId) throw new Error('seed failed');
		const attributedSendId = sendId;

		expect(
			await t.mutation(internal.delivery.unsubscribeOutcome.recordUnsubscribeOutcome, {
				contactId,
			})
		).toBe('recorded');
		await t.run(async (ctx) => {
			expect(await readBuckets(ctx)).toHaveLength(0);
			// The unsubscribe WAS processed for this send; the stamp says so, so a
			// redelivered POST cannot go looking for a second attribution.
			expect((await ctx.db.get(attributedSendId))?.unsubscribedAt).toBeGreaterThan(0);
		});
	});
});

/**
 * THE REGRESSION THIS PIECE IS ABOUT.
 *
 * Two identically-scaffolded cells, differing ONLY in whether the emitter ran
 * against them. `UNSUBSCRIBE_PROXY_SPEC` compares the window's unsubscribe rate
 * against the cell's own trailing one, and `relativeCeilingIsMeasurable` refuses
 * a zero trailing rate — so the cell with no writer for the counter holds at
 * `baseline_not_a_denominator` forever, which is what froze the standalone twin.
 *
 * The unsubscribe NUMERATORS below are written by the emitter, one real
 * attributed send each. The 1000-send sample floor underneath them is seeded as
 * bucket rows: producing it through the lifecycle would be a thousand
 * transitions per window, and the gate reads it only to decide that the window
 * is large enough to speak about.
 */
describe('standalone gate 3 can reach a verdict once the counter has a writer', () => {
	const EVALUATION_AT = NOW - 60 * 60 * 1000;
	const BASELINE_AT = NOW - 10 * DAY_MS;
	const EVALUATION_WINDOW = { since: NOW - 2 * DAY_MS, until: NOW + 1 };
	const BASELINE_WINDOW = { since: NOW - 11 * DAY_MS, until: NOW - 9 * DAY_MS };

	/** `sent`/`delivered` for one cell-window, at the gate's sample floor. */
	async function seedWindowVolume(
		ctx: { db: DatabaseWriter },
		cell: DeliverabilityCellKey,
		at: number
	): Promise<void> {
		await ctx.db.insert(
			'transportOutcomes',
			bucketRow({ cell, periodStart: startOfDayUtc(at), shardKey: 0, sent: 1000, delivered: 1000 })
		);
	}

	async function unsubscribeOne(
		t: ReturnType<typeof convexTest>,
		cell: DeliverabilityCellKey,
		at: number
	): Promise<void> {
		let contactId: Id<'contacts'> | undefined;
		await t.run(async (ctx) => {
			const seeded = await seedAssignedSend(ctx, {
				status: 'delivered',
				assignment: { cell },
			});
			contactId = seeded.contactId;
		});
		if (!contactId) throw new Error('seed failed');
		await t.mutation(internal.delivery.unsubscribeOutcome.recordUnsubscribeOutcome, {
			contactId,
			at,
		});
	}

	async function evaluate(t: ReturnType<typeof convexTest>, cell: DeliverabilityCellKey) {
		return await t.run(async (ctx) => {
			const armQuery = { organizationId: OUTCOME_ORG, cell, arm: 'own' as const };
			const own = await summarizeTransportOutcomes(ctx.db, { ...armQuery, ...EVALUATION_WINDOW });
			const baseline = await summarizeTransportOutcomes(ctx.db, {
				...armQuery,
				...BASELINE_WINDOW,
			});
			return {
				own,
				baseline,
				verdict: evaluateStandaloneComplaintGate(
					input({ own, ownTrailingBaseline: baseline, now: NOW })
				),
			};
		});
	}

	it('decides on emitter-written unsubscribes, and holds on the same cell without them', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			for (const at of [EVALUATION_AT, BASELINE_AT]) {
				await seedWindowVolume(ctx, GMAIL_CAMPAIGN_CELL, at);
				await seedWindowVolume(ctx, MICROSOFT_CAMPAIGN_CELL, at);
			}
		});
		// Only the Gmail cell gets unsubscribes; Microsoft is the same cell as it
		// looked before this piece — every other counter written, this one empty.
		await unsubscribeOne(t, GMAIL_CAMPAIGN_CELL, EVALUATION_AT);
		await unsubscribeOne(t, GMAIL_CAMPAIGN_CELL, BASELINE_AT);
		await unsubscribeOne(t, GMAIL_CAMPAIGN_CELL, BASELINE_AT);

		const measured = await evaluate(t, GMAIL_CAMPAIGN_CELL);
		// Rates derived on read by the real summarizer from the real writes.
		expect(measured.own.unsubscribed).toBe(1);
		expect(measured.baseline.unsubscribed).toBe(2);
		expect(measured.verdict.status).toBe('pass');
		expect(measured.verdict.reason).toBe('within_threshold');
		// A proxy, labelled as one — and still evidence an increase may rest on.
		expect(measured.verdict.confidence).toBe('medium');
		expect(measured.verdict.mayJustifyIncrease).toBe(true);

		const unwritten = await evaluate(t, MICROSOFT_CAMPAIGN_CELL);
		expect(unwritten.baseline.unsubscribed).toBe(0);
		expect(unwritten.verdict.status).toBe('insufficient_data');
		expect(unwritten.verdict.reason).toBe('baseline_not_a_denominator');
	});

	// The other half of "reaches a verdict": the proxy can RETREAT a cell, on
	// nothing but attributed unsubscribes. The 3x boundary itself is pinned in
	// the pure gate suite; what this asserts is that the emitter's writes are
	// what carry a cell past it.
	it('fails the cell when the measured window rate runs away from the trailing one', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			for (const at of [EVALUATION_AT, BASELINE_AT]) {
				await seedWindowVolume(ctx, GMAIL_CAMPAIGN_CELL, at);
			}
		});
		await unsubscribeOne(t, GMAIL_CAMPAIGN_CELL, BASELINE_AT);
		for (let i = 0; i < 4; i += 1) {
			await unsubscribeOne(t, GMAIL_CAMPAIGN_CELL, EVALUATION_AT);
		}

		const measured = await evaluate(t, GMAIL_CAMPAIGN_CELL);
		expect(measured.own.unsubscribed).toBe(4);
		expect(measured.baseline.unsubscribed).toBe(1);
		expect(measured.verdict.status).toBe('fail');
		expect(measured.verdict.reason).toBe('trailing_baseline_breached');
	});
});
