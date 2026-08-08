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
	drainOutcomeWrites,
} from '../../analytics/__tests__/transportOutcomesFixtures';
import { ATTRIBUTION_LOOKBACK_SENDS } from '../marketingSendAttribution';
import type { RecordUnsubscribeOutcomeResult } from '../unsubscribeOutcome';
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
async function joinTopic(
	ctx: { db: DatabaseWriter },
	contactId: Id<'contacts'>
): Promise<Id<'topics'>> {
	const topicId = await ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: false }));
	await ctx.db.insert('contactTopics', { contactId, topicId, addedAt: Date.now() });
	return topicId;
}

/**
 * The attribution recorder, run to completion — the mutation AND the shard bump
 * it schedules out of itself (see `drainOutcomeWrites`). Every case that reads
 * counters back goes through here, so no case can assert on a half-run write.
 */
async function recordUnsubscribe(
	t: ReturnType<typeof convexTest>,
	args: { contactId: Id<'contacts'>; at?: number }
): Promise<RecordUnsubscribeOutcomeResult> {
	const result = await t.mutation(
		internal.delivery.unsubscribeOutcome.recordUnsubscribeOutcome,
		args
	);
	await drainOutcomeWrites(t);
	return result;
}

/** Every scheduled run of the attribution recorder, however it was reached. */
async function scheduledRecorderRuns(ctx: { db: DatabaseWriter }): Promise<unknown[]> {
	const scheduled = await ctx.db.system.query('_scheduled_functions').collect();
	return scheduled.filter((job) => job.name.includes('recordUnsubscribeOutcome'));
}

async function seedContact(ctx: { db: DatabaseWriter }): Promise<Id<'contacts'>> {
	return await ctx.db.insert('contacts', createTestContact());
}

/**
 * Two dispatch stamps an hour apart, both in the past.
 *
 * Cases that seed a send at `DISPATCHED_LAST` and then CREATE one at
 * `DISPATCHED_FIRST` invert row age against send order — which is what a
 * pre-created blast audience does in production, and the only shape that tells
 * a dispatch-ordered attribution apart from a creation-ordered one.
 */
const HOUR_MS = 60 * 60 * 1000;
const DISPATCHED_FIRST = Date.now() - 2 * HOUR_MS;
const DISPATCHED_LAST = Date.now() - HOUR_MS;

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
		/** The dispatch stamp — see the campaign fixture's `sentAt`. */
		sentAt?: number;
	}
): Promise<Id<'transactionalSends'>> {
	const sendId = await ctx.db.insert('transactionalSends', {
		kind: options.kind,
		email: 'recipient@example.com',
		contactId: options.contactId,
		status: options.status ?? 'delivered',
		queuedAt: Date.now(),
		...(options.sentAt !== undefined ? { sentAt: options.sentAt } : {}),
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

	// THE SEGMENT-AUDIENCE RECIPIENT. A campaign whose audience is a segment
	// resolves its recipients from the contacts table, so they have no
	// `contactTopics` row at all — and `resolveListUnsubscribeHeader` still gives
	// them the contact one-click pair. Their unsubscribe deletes no membership
	// and removes no list; if the counter only had a writer when a membership
	// died, a segment-sending deployment would hold gate 3 at
	// `insufficient_data` forever, which is the defect this emitter closes.
	it('records for a recipient with no topic memberships at all', async () => {
		vi.useFakeTimers();
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'> | undefined;
		let sendId: Id<'emailSends'> | undefined;
		await t.run(async (ctx) => {
			const seeded = await seedAssignedSend(ctx, { status: 'delivered', assignment: {} });
			contactId = seeded.contactId;
			sendId = seeded.sendId;
		});
		if (!contactId || !sendId) throw new Error('seed failed');
		const attributedSendId = sendId;

		// The endpoint's own answer for this contact: nothing to remove.
		const result = await t.mutation(internal.delivery.unsubscribeQueries.processUnsubscribe, {
			contactId,
		});
		expect(result).toEqual({ success: true, alreadyUnsubscribed: true });
		await t.finishAllScheduledFunctions(() => vi.runAllTimers());

		await t.run(async (ctx) => {
			// The opt-out itself landed — the contact is out of every segment.
			expect((await ctx.db.get(contactId!))?.unsubscribedAt).toBeGreaterThan(0);
			expect(sumCounters(await readBuckets(ctx))).toEqual({
				...ZERO_TRANSPORT_OUTCOME_TOTALS,
				unsubscribed: 1,
			});
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

		await recordUnsubscribe(t, {
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
			await recordUnsubscribe(t, {
				contactId,
			})
		).toBe('attributed');
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

		await recordUnsubscribe(t, {
			contactId,
		});
		await t.run(async (ctx) => {
			expect((await readBuckets(ctx))[0]?.cell).toBe(GMAIL_CAMPAIGN_CELL);
		});
	});

	// THE TIMEZONE-STAGGERED BLAST, ACROSS THE TWO TABLES. `createBatch`
	// pre-creates a campaign's whole audience up to a day before the dispatch
	// transaction reaches this recipient's timezone, so ROW AGE IS NOT SEND
	// ORDER: the drip below is created last and delivered first. The two
	// candidates carry different `sendAssignments` rows, so a creation-ordered
	// winner would put the numerator — and, through the shared join, the
	// dashboard number — on a message the contact had not received yet.
	it('answers with the last-DISPATCHED candidate, not the last-created one', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'> | undefined;
		await t.run(async (ctx) => {
			const seeded = await seedAssignedSend(ctx, {
				status: 'delivered',
				sentAt: DISPATCHED_LAST,
				assignment: { cell: GMAIL_CAMPAIGN_CELL },
			});
			contactId = seeded.contactId;
		});
		if (!contactId) throw new Error('seed failed');
		// Created after the campaign row, handed to a transport an hour before it.
		await t.run(async (ctx) => {
			await seedNonCampaignSend(ctx, {
				contactId: contactId!,
				kind: 'automation',
				cell: MICROSOFT_CAMPAIGN_CELL,
				sentAt: DISPATCHED_FIRST,
			});
		});

		expect(
			await recordUnsubscribe(t, {
				contactId,
			})
		).toBe('attributed');
		await t.run(async (ctx) => {
			const buckets = await readBuckets(ctx);
			expect(buckets[0]?.cell).toBe(GMAIL_CAMPAIGN_CELL);
			expect(sumCounters(buckets)).toEqual({
				...ZERO_TRANSPORT_OUTCOME_TOTALS,
				unsubscribed: 1,
			});
		});
	});

	// The same inversion WITHIN `emailSends` alone — two blasts overlapping in
	// creation, dispatched in the other order.
	it('answers with the last-dispatched of two campaign sends', async () => {
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'> | undefined;
		await t.run(async (ctx) => {
			const seeded = await seedAssignedSend(ctx, {
				status: 'delivered',
				sentAt: DISPATCHED_LAST,
				assignment: { cell: GMAIL_CAMPAIGN_CELL },
			});
			contactId = seeded.contactId;
			await seedAssignedSend(ctx, {
				contactId: seeded.contactId,
				status: 'delivered',
				sentAt: DISPATCHED_FIRST,
				assignment: { cell: MICROSOFT_CAMPAIGN_CELL },
			});
		});
		if (!contactId) throw new Error('seed failed');

		await recordUnsubscribe(t, {
			contactId,
		});
		await t.run(async (ctx) => {
			const buckets = await readBuckets(ctx);
			expect(buckets[0]?.cell).toBe(GMAIL_CAMPAIGN_CELL);
			expect(sumCounters(buckets)).toEqual({
				...ZERO_TRANSPORT_OUTCOME_TOTALS,
				unsubscribed: 1,
			});
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
			await recordUnsubscribe(t, {
				contactId,
			})
		).toBe('attributed');

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
			await recordUnsubscribe(t, {
				contactId,
			})
		).toBe('no_marketing_send');
		await t.run(async (ctx) => {
			expect(await readBuckets(ctx)).toHaveLength(0);
		});
	});
});

/**
 * The dashboard number and the ramp counter, on one unsubscribe.
 *
 * `campaigns.statsUnsubscribed` (`topics/subscription.recordCampaignUnsubscribe`)
 * and the `unsubscribed` transport outcome are written by two mutations
 * scheduled off the same public unsubscribe. They share the attribution join
 * (`marketingSendAttribution.ts`) precisely so they cannot name different
 * campaigns for one departure — and the shipped dashboard number is what moves
 * if the join is wrong, so each case here asserts BOTH writers.
 */
describe('both writers name the same campaign', () => {
	it('credits the delivered campaign, not the queued pre-creation of the next blast', async () => {
		vi.useFakeTimers();
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'> | undefined;
		let deliveredCampaignId: Id<'campaigns'> | undefined;
		let queuedCampaignId: Id<'campaigns'> | undefined;
		await t.run(async (ctx) => {
			const delivered = await seedAssignedSend(ctx, {
				status: 'delivered',
				sentAt: DISPATCHED_LAST,
				assignment: { cell: MICROSOFT_CAMPAIGN_CELL },
			});
			contactId = delivered.contactId;
			deliveredCampaignId = delivered.campaignId;
			// The next blast's audience: created last, handed to no transport yet.
			queuedCampaignId = (
				await seedAssignedSend(ctx, {
					contactId: delivered.contactId,
					status: 'queued',
					assignment: { cell: GMAIL_CAMPAIGN_CELL },
				})
			).campaignId;
			await joinTopic(ctx, delivered.contactId);
		});
		if (!contactId || !deliveredCampaignId || !queuedCampaignId) throw new Error('seed failed');
		const [delivered, queued] = [deliveredCampaignId, queuedCampaignId];

		await t.mutation(internal.delivery.unsubscribeQueries.processUnsubscribe, { contactId });
		await t.finishAllScheduledFunctions(() => vi.runAllTimers());

		await t.run(async (ctx) => {
			expect((await ctx.db.get(delivered))?.statsUnsubscribed).toBe(1);
			expect((await ctx.db.get(queued))?.statsUnsubscribed).toBe(0);
			const buckets = await readBuckets(ctx);
			expect(buckets[0]?.cell).toBe(MICROSOFT_CAMPAIGN_CELL);
			expect(sumCounters(buckets)).toEqual({
				...ZERO_TRANSPORT_OUTCOME_TOTALS,
				unsubscribed: 1,
			});
		});
	});

	// Both rows delivered, so neither writer can fall back on status: the only
	// thing separating them is which one a transport was handed last.
	it('credits the last-dispatched campaign when a later-created one went out first', async () => {
		vi.useFakeTimers();
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'> | undefined;
		let answeredCampaignId: Id<'campaigns'> | undefined;
		let earlierCampaignId: Id<'campaigns'> | undefined;
		await t.run(async (ctx) => {
			const answered = await seedAssignedSend(ctx, {
				status: 'delivered',
				sentAt: DISPATCHED_LAST,
				assignment: { cell: MICROSOFT_CAMPAIGN_CELL },
			});
			contactId = answered.contactId;
			answeredCampaignId = answered.campaignId;
			earlierCampaignId = (
				await seedAssignedSend(ctx, {
					contactId: answered.contactId,
					status: 'delivered',
					sentAt: DISPATCHED_FIRST,
					assignment: { cell: GMAIL_CAMPAIGN_CELL },
				})
			).campaignId;
			await joinTopic(ctx, answered.contactId);
		});
		if (!contactId || !answeredCampaignId || !earlierCampaignId) throw new Error('seed failed');
		const [answered, earlier] = [answeredCampaignId, earlierCampaignId];

		await t.mutation(internal.delivery.unsubscribeQueries.processUnsubscribe, { contactId });
		await t.finishAllScheduledFunctions(() => vi.runAllTimers());

		await t.run(async (ctx) => {
			expect((await ctx.db.get(answered))?.statsUnsubscribed).toBe(1);
			expect((await ctx.db.get(earlier))?.statsUnsubscribed).toBe(0);
			const buckets = await readBuckets(ctx);
			expect(buckets[0]?.cell).toBe(MICROSOFT_CAMPAIGN_CELL);
			expect(sumCounters(buckets)).toEqual({
				...ZERO_TRANSPORT_OUTCOME_TOTALS,
				unsubscribed: 1,
			});
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
			await recordUnsubscribe(t, {
				contactId,
			})
		).toBe('attributed');
		expect(
			await recordUnsubscribe(t, {
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

/**
 * The preference centre is the OTHER receiver-side source. It is only reachable
 * through the footer link of a message we sent, so leaving from it is the same
 * signal the one-click target is — and it is the source with the fan-out
 * problem: one save can switch off any number of topics.
 */
describe('the preference centre', () => {
	it('records a global unsubscribe made from the preference page', async () => {
		vi.useFakeTimers();
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'> | undefined;
		await t.run(async (ctx) => {
			const seeded = await seedAssignedSend(ctx, {
				status: 'delivered',
				assignment: { cell: MICROSOFT_CAMPAIGN_CELL },
			});
			await joinTopic(ctx, seeded.contactId);
			contactId = seeded.contactId;
		});
		if (!contactId) throw new Error('seed failed');

		expect(
			await t.mutation(internal.delivery.preferencesQueries.updateContactPreferences, {
				contactId,
				globalUnsubscribe: true,
			})
		).toEqual({ success: true });
		await t.finishAllScheduledFunctions(() => vi.runAllTimers());

		await t.run(async (ctx) => {
			const buckets = await readBuckets(ctx);
			expect(buckets[0]?.cell).toBe(MICROSOFT_CAMPAIGN_CELL);
			expect(sumCounters(buckets)).toEqual({
				...ZERO_TRANSPORT_OUTCOME_TOTALS,
				unsubscribed: 1,
			});
		});
	});

	// One save is ONE recipient action. Attributing it once per topic switched
	// off would schedule N runs of the same contact→send join, all contending on
	// the same send row for a numerator that may only move once.
	it('attributes a save that switches three topics off exactly once', async () => {
		vi.useFakeTimers();
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'> | undefined;
		let topicIds: Id<'topics'>[] = [];
		await t.run(async (ctx) => {
			const seeded = await seedAssignedSend(ctx, { status: 'delivered', assignment: {} });
			contactId = seeded.contactId;
			topicIds = [
				await joinTopic(ctx, contactId),
				await joinTopic(ctx, contactId),
				await joinTopic(ctx, contactId),
			];
		});
		if (!contactId) throw new Error('seed failed');

		await t.mutation(internal.delivery.preferencesQueries.updateContactPreferences, {
			contactId,
			topicUpdates: topicIds.map((topicId) => ({ topicId, subscribed: false })),
		});
		// Counted BEFORE the queue drains: the claim is about how many runs the
		// save scheduled, which the recorder's own idempotence would otherwise
		// hide behind an identical counter.
		await t.run(async (ctx) => {
			expect(await scheduledRecorderRuns(ctx)).toHaveLength(1);
		});
		await t.finishAllScheduledFunctions(() => vi.runAllTimers());

		await t.run(async (ctx) => {
			expect(sumCounters(await readBuckets(ctx))).toEqual({
				...ZERO_TRANSPORT_OUTCOME_TOTALS,
				unsubscribed: 1,
			});
			// All three memberships are gone — coalescing the effects did not
			// coalesce the deletions.
			const memberships = await ctx.db
				.query('contactTopics')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId!))
				.collect();
			expect(memberships).toHaveLength(0);
			// A topic-scoped save is NOT a contact-level opt-out: the contact stays
			// reachable by a segment audience they still match.
			expect((await ctx.db.get(contactId!))?.unsubscribedAt).toBeUndefined();
		});
	});

	// A save is a SET OF PER-TOPIC INTENTS, not a script to replay. A payload
	// naming one topic twice settles on its last toggle, and produces no
	// membership churn on the way: replaying it in order would delete the kept
	// topic and re-insert it, leaving a `topic_unsubscribed` activity row on the
	// contact's timeline for a topic they never left — and, on a payload where
	// the off/on pair is the ONLY toggle, spending their one attributable
	// unsubscribe on it.
	it('settles a topic named twice on its last toggle, with no unsubscribe on the way', async () => {
		vi.useFakeTimers();
		const t = convexTest(schema, modules);
		let contactId: Id<'contacts'> | undefined;
		let keptTopicId: Id<'topics'> | undefined;
		let droppedTopicId: Id<'topics'> | undefined;
		await t.run(async (ctx) => {
			const seeded = await seedAssignedSend(ctx, { status: 'delivered', assignment: {} });
			contactId = seeded.contactId;
			keptTopicId = await joinTopic(ctx, seeded.contactId);
			droppedTopicId = await joinTopic(ctx, seeded.contactId);
		});
		if (!contactId || !keptTopicId || !droppedTopicId) throw new Error('seed failed');
		const [kept, dropped] = [keptTopicId, droppedTopicId];

		await t.mutation(internal.delivery.preferencesQueries.updateContactPreferences, {
			contactId,
			topicUpdates: [
				{ topicId: kept, subscribed: false },
				{ topicId: dropped, subscribed: false },
				{ topicId: kept, subscribed: true },
			],
		});
		await t.finishAllScheduledFunctions(() => vi.runAllTimers());

		await t.run(async (ctx) => {
			const memberships = await ctx.db
				.query('contactTopics')
				.withIndex('by_contact', (q) => q.eq('contactId', contactId!))
				.collect();
			expect(memberships.map((m) => m.topicId)).toEqual([kept]);
			// Exactly one departure happened, and it names the topic that was asked
			// for — the kept topic left no trace of a delete-then-reinsert.
			const unsubscribeActivities = (
				await ctx.db
					.query('contactActivities')
					.withIndex('by_contact', (q) => q.eq('contactId', contactId!))
					.collect()
			).filter((activity) => activity.activityType === 'topic_unsubscribed');
			expect(unsubscribeActivities).toHaveLength(1);
			expect(unsubscribeActivities[0]?.metadata?.['topicId']).toBe(String(dropped));
			expect(sumCounters(await readBuckets(ctx))).toEqual({
				...ZERO_TRANSPORT_OUTCOME_TOTALS,
				unsubscribed: 1,
			});
		});
	});

	// The corollary: the ARRAY ORDER decides nothing. Settling every subscribe
	// before every unsubscribe is only safe because a topic appears in exactly one
	// of the two groups, so a payload and its reversal have to land identically.
	it('settles the same way whichever order the toggles were written in', async () => {
		vi.useFakeTimers();
		const t = convexTest(schema, modules);

		/** The topics the contact still belongs to, BY ROLE — the two runs seed
		 * two different contacts, so raw ids would never compare equal. */
		async function settle(
			updates: (ids: { on: Id<'topics'>; off: Id<'topics'> }) => Array<{
				topicId: Id<'topics'>;
				subscribed: boolean;
			}>
		): Promise<Array<'on' | 'off'>> {
			let contactId: Id<'contacts'> | undefined;
			let joined: Id<'topics'> | undefined;
			let notJoined: Id<'topics'> | undefined;
			await t.run(async (ctx) => {
				contactId = await seedContact(ctx);
				joined = await joinTopic(ctx, contactId);
				notJoined = await ctx.db.insert('topics', createTestTopic({ requireDoubleOptIn: false }));
			});
			if (!contactId || !joined || !notJoined) throw new Error('seed failed');
			const [stays, leaves] = [notJoined, joined];
			await t.mutation(internal.delivery.preferencesQueries.updateContactPreferences, {
				contactId,
				topicUpdates: updates({ on: stays, off: leaves }),
			});
			await t.finishAllScheduledFunctions(() => vi.runAllTimers());
			return await t.run(async (ctx) => {
				const memberships = await ctx.db
					.query('contactTopics')
					.withIndex('by_contact', (q) => q.eq('contactId', contactId!))
					.collect();
				return memberships.map((m) => (m.topicId === stays ? 'on' : 'off'));
			});
		}

		const subscribeFirst = await settle(({ on, off }) => [
			{ topicId: on, subscribed: true },
			{ topicId: off, subscribed: false },
		]);
		const unsubscribeFirst = await settle(({ on, off }) => [
			{ topicId: off, subscribed: false },
			{ topicId: on, subscribed: true },
		]);
		// The subscribe landed, the unsubscribe landed, and the order did not
		// change which is which.
		expect(subscribeFirst).toEqual(['on']);
		expect(unsubscribeFirst).toEqual(subscribeFirst);
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
			await recordUnsubscribe(t, {
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
			await recordUnsubscribe(t, {
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
			await recordUnsubscribe(t, {
				contactId,
			})
		).toBe('attributed');
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
		await recordUnsubscribe(t, {
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
