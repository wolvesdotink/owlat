/**
 * transportOutcomes — the read path (plan D5: derive on read, never store).
 *
 * The summarizer is the single place a rate exists. Coverage here:
 *   - it sums across ALL shards and ALL days in the window, so the write-side
 *     shard split is invisible to readers;
 *   - every rate is derived, and every zero denominator yields 0 rather than
 *     NaN/Infinity;
 *   - it is READER-TYPED: the identical function produces the identical numbers
 *     from a query ctx and from a mutation ctx, which is what makes it
 *     impossible for the controller and the dashboard to disagree;
 *   - the window bounds are honoured and hostile inputs degrade to 0.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import schema from '../../schema';
import {
	recordTransportOutcomeForCell,
	summarizeTransportOutcomeArms,
	summarizeTransportOutcomes,
	TRANSPORT_OUTCOME_SHARD_COUNT,
	type TransportOutcomeBucket,
} from '../transportOutcomes';
import {
	DEFERRAL_TELEMETRY_MIN_OBSERVED_MS,
	DEFERRAL_TELEMETRY_SPAN_MS,
	hasUsableDeferralTelemetry,
	summarizeTransportOutcomeBuckets,
} from '../transportOutcomeSummary';
import { startOfDayUtc } from '../../lib/clock';
import { modules } from '../../__tests__/testModules';
import {
	bucketRow,
	DAY_MS,
	GMAIL_CAMPAIGN_CELL,
	MICROSOFT_CAMPAIGN_CELL,
	OUTCOME_ORG,
} from './transportOutcomesFixtures';

const DAY = startOfDayUtc(Date.UTC(2026, 6, 20, 13, 45));

function asBucket(row: ReturnType<typeof bucketRow>): TransportOutcomeBucket {
	// The pure summarizer only reads counters + periodStart; the system fields
	// are irrelevant to it, which is exactly why it is testable without a db.
	return { ...row, _id: 'x' as TransportOutcomeBucket['_id'], _creationTime: 0 };
}

describe('summarizeTransportOutcomeBuckets (pure)', () => {
	it('sums across shards and days, and derives every rate on read', () => {
		const summary = summarizeTransportOutcomeBuckets([
			asBucket(
				bucketRow({
					periodStart: DAY,
					shardKey: 0,
					sent: 600,
					delivered: 500,
					deferred: 30,
					softBounced: 40,
					hardBounced: 20,
					complained: 3,
					opened: 250,
					clicked: 50,
					unsubscribed: 5,
				})
			),
			asBucket(
				bucketRow({
					periodStart: DAY - DAY_MS,
					shardKey: 5,
					sent: 400,
					delivered: 300,
					deferred: 10,
					softBounced: 20,
					hardBounced: 20,
					complained: 1,
					opened: 150,
					clicked: 30,
					unsubscribed: 5,
				})
			),
		]);

		expect(summary.sent).toBe(1000);
		expect(summary.delivered).toBe(800);
		expect(summary.bounced).toBe(100);
		expect(summary.deliveryRate).toBeCloseTo(0.8, 10);
		expect(summary.deferralRate).toBeCloseTo(0.04, 10);
		expect(summary.bounceRate).toBeCloseTo(0.1, 10);
		expect(summary.hardBounceRate).toBeCloseTo(0.04, 10);
		expect(summary.complaintRate).toBeCloseTo(0.004, 10);
		expect(summary.openRate).toBeCloseTo(0.5, 10);
		expect(summary.clickRate).toBeCloseTo(0.1, 10);
		expect(summary.unsubscribeRate).toBeCloseTo(0.0125, 10);
	});

	it('returns 0 for every rate when the denominators are 0 (no division by zero)', () => {
		const summary = summarizeTransportOutcomeBuckets([]);
		for (const rate of [
			summary.deliveryRate,
			summary.deferralRate,
			summary.bounceRate,
			summary.hardBounceRate,
			summary.complaintRate,
			summary.openRate,
			summary.clickRate,
			summary.unsubscribeRate,
			summary.calibrationOpenRate,
			summary.calibrationClickRate,
		]) {
			expect(rate).toBe(0);
			expect(Number.isNaN(rate)).toBe(false);
		}
		expect(summary.sent).toBe(0);
	});

	it('never divides an opened count by a zero delivered count', () => {
		const summary = summarizeTransportOutcomeBuckets([
			asBucket(bucketRow({ periodStart: DAY, shardKey: 0, sent: 10, opened: 4 })),
		]);
		expect(summary.openRate).toBe(0);
		expect(Number.isFinite(summary.openRate)).toBe(true);
	});

	it('clamps a rate whose numerator exceeds its denominator to 1', () => {
		// The counters cannot get here through the shipped write path any more —
		// `delivered >= opened` holds by construction. This is the read-boundary
		// backstop for a legacy or partially-written bucket: a gate reads these
		// numbers as ratios and must never be handed one above 1.
		const summary = summarizeTransportOutcomeBuckets([
			asBucket(
				bucketRow({ periodStart: DAY, shardKey: 0, sent: 4, delivered: 3, opened: 9, clicked: 7 })
			),
		]);
		expect(summary.openRate).toBe(1);
		expect(summary.clickRate).toBe(1);
	});

	it('keeps openRate inside [0, 1] in a mixed cell (callback sends + open-only sends)', () => {
		// The regression this pins: some sends in a cell get a provider
		// `delivered` callback, others are only ever observed through their open.
		// If the open-only sends did not also bump `delivered`, `opened` would
		// exceed `delivered` here and `openRate` would read 1.67.
		const summary = summarizeTransportOutcomeBuckets([
			// three sends whose first evidence was the provider callback
			asBucket(bucketRow({ periodStart: DAY, shardKey: 0, sent: 5, delivered: 3 })),
			// two sends whose ONLY evidence was the open — delivered and opened
			// move together, exactly as the lifecycle now records them
			asBucket(bucketRow({ periodStart: DAY, shardKey: 1, delivered: 2, opened: 2 })),
			// …plus opens on two of the callback sends
			asBucket(bucketRow({ periodStart: DAY, shardKey: 2, opened: 2 })),
		]);
		expect(summary.delivered).toBe(5);
		expect(summary.opened).toBe(4);
		expect(summary.openRate).toBeLessThanOrEqual(1);
		expect(summary.openRate).toBeCloseTo(0.8, 10);
	});

	it('treats NaN / negative / infinite counters as 0 rather than poisoning the cell', () => {
		const summary = summarizeTransportOutcomeBuckets([
			asBucket(
				bucketRow({
					periodStart: DAY,
					shardKey: 0,
					sent: Number.NaN,
					delivered: Number.POSITIVE_INFINITY,
					softBounced: -5,
					hardBounced: 3,
				})
			),
			asBucket(bucketRow({ periodStart: DAY, shardKey: 1, sent: 100, delivered: 90 })),
		]);
		expect(summary.sent).toBe(100);
		expect(summary.delivered).toBe(90);
		expect(summary.softBounced).toBe(0);
		expect(summary.bounced).toBe(3);
		expect(summary.bounceRate).toBeCloseTo(0.03, 10);
	});

	it('drops buckets with a non-finite periodStart', () => {
		const summary = summarizeTransportOutcomeBuckets([
			asBucket(bucketRow({ periodStart: Number.NaN, shardKey: 0, sent: 50 })),
		]);
		expect(summary.sent).toBe(0);
	});

	it('honours the window: `since` is day-floored and `until` is exclusive', () => {
		const buckets = [
			asBucket(bucketRow({ periodStart: DAY - 2 * DAY_MS, shardKey: 0, sent: 1 })),
			asBucket(bucketRow({ periodStart: DAY - DAY_MS, shardKey: 0, sent: 10 })),
			asBucket(bucketRow({ periodStart: DAY, shardKey: 0, sent: 100 })),
		];
		// A mid-day `since` must still include that whole day's bucket.
		expect(summarizeTransportOutcomeBuckets(buckets, { since: DAY - DAY_MS + 3600_000 }).sent).toBe(
			110
		);
		expect(summarizeTransportOutcomeBuckets(buckets, { since: DAY }).sent).toBe(100);
		expect(summarizeTransportOutcomeBuckets(buckets, { until: DAY }).sent).toBe(11);
		expect(
			summarizeTransportOutcomeBuckets(buckets, { since: DAY - DAY_MS, until: DAY }).sent
		).toBe(10);
	});

	it('ignores a non-finite window bound instead of returning nothing', () => {
		const buckets = [asBucket(bucketRow({ periodStart: DAY, shardKey: 0, sent: 7 }))];
		expect(summarizeTransportOutcomeBuckets(buckets, { since: Number.NaN }).sent).toBe(7);
		expect(summarizeTransportOutcomeBuckets(buckets, { until: Number.NaN }).sent).toBe(7);
	});

	it('reports freshness as the newest lastRecordedAt inside the window', () => {
		// The controller may only INCREASE on fresh evidence, and it must learn
		// how fresh through this one read seam rather than re-reading raw rows.
		const buckets = [
			asBucket(bucketRow({ periodStart: DAY - DAY_MS, shardKey: 0, sent: 1 })),
			asBucket(bucketRow({ periodStart: DAY, shardKey: 1, sent: 1 })),
		];
		expect(summarizeTransportOutcomeBuckets(buckets).lastRecordedAt).toBe(DAY);
		// A bucket outside the window contributes neither counts nor freshness.
		expect(summarizeTransportOutcomeBuckets(buckets, { until: DAY }).lastRecordedAt).toBe(
			DAY - DAY_MS
		);
		expect(summarizeTransportOutcomeBuckets([]).lastRecordedAt).toBeNull();
	});

	/**
	 * THE PREDICATE EVERY READER ACTUALLY CALLS — gate 2, the delivery dashboard
	 * and the phase-promotion rule. Two facts satisfy it, and the second one is
	 * what stops the hold being permanent: a deployment whose warm-up overflow
	 * routes to a relay never records a deferral, and gate 2's `insufficient_data`
	 * outranks every `pass` beside it.
	 */
	describe('hasUsableDeferralTelemetry', () => {
		/** Rows for `days` UTC days back from `DAY`, one shard each, all spotless. */
		function sendingOn(days: readonly number[]): TransportOutcomeBucket[] {
			return days.map((offset, index) =>
				asBucket(
					bucketRow({ periodStart: DAY - offset * DAY_MS, shardKey: index % 8, sent: 5_000 })
				)
			);
		}

		it('separates a zero deferral rate from an unwritten deferral counter', () => {
			// Both produce the identical `deferralRate` of 0, and gate 2 may only act
			// on the first — so the instrument is a question the rate cannot answer.
			const spotless = sendingOn([0]);
			expect(summarizeTransportOutcomeBuckets(spotless).deferralRate).toBe(0);
			expect(hasUsableDeferralTelemetry(spotless, DAY)).toBe(false);

			expect(
				hasUsableDeferralTelemetry(
					[
						...spotless,
						asBucket(bucketRow({ periodStart: DAY - 20 * DAY_MS, shardKey: 1, deferred: 1 })),
					],
					DAY
				)
			).toBe(true);
			// A poisoned counter is not a witness: `safeOutcomeCount` refuses it,
			// exactly as the summation does.
			expect(
				hasUsableDeferralTelemetry(
					[asBucket(bucketRow({ periodStart: DAY, shardKey: 0, sent: 10, deferred: Number.NaN }))],
					DAY
				)
			).toBe(false);
			expect(hasUsableDeferralTelemetry([], DAY)).toBe(false);
		});

		it('waits while the arm’s traffic is younger than the observation minimum', () => {
			// Ample volume, all of it this week: nothing has been observed about the
			// counter over a period long enough to call its silence a reading.
			expect(hasUsableDeferralTelemetry(sendingOn([0, 1, 2, 3, 4, 5, 6]), DAY)).toBe(false);
			const minimumDays = DEFERRAL_TELEMETRY_MIN_OBSERVED_MS / DAY_MS;
			expect(hasUsableDeferralTelemetry(sendingOn([0, minimumDays - 1]), DAY)).toBe(false);
			expect(hasUsableDeferralTelemetry(sendingOn([0, minimumDays]), DAY)).toBe(true);
		});

		/**
		 * THE CASE THE DAY-ANCHORED VERSION OF THIS PREDICATE FAILED. A cell that
		 * does not send at weekends is quiet on both of the span's oldest days once
		 * every seven, so a test anchored on that day re-entered the hold weekly —
		 * clearing `greenSince` and restarting the fourteen-day graduation clock
		 * with it, which is the permanent block plan D2 forbids, made intermittent.
		 */
		it('reads continuous traffic as observed even with the span’s oldest days quiet', () => {
			const everyDay = Array.from({ length: 29 }, (_, index) => index);
			expect(hasUsableDeferralTelemetry(sendingOn(everyDay), DAY)).toBe(true);
			// Weekdays only, with the weekend falling on the span's oldest days: the
			// span reaches back 29 days, and this cell last sent 26 days ago.
			const weekend = new Set([6, 7, 13, 14, 20, 21, 27, 28]);
			const weekdays = everyDay.filter((offset) => !weekend.has(offset));
			expect(Math.max(...weekdays)).toBe(26);
			expect(hasUsableDeferralTelemetry(sendingOn(weekdays), DAY)).toBe(true);
			// One batch a week — four sending days in the span, and just as entitled
			// to an answer as a cell that sends every day.
			expect(hasUsableDeferralTelemetry(sendingOn([0, 7, 14, 21]), DAY)).toBe(true);
		});

		it('is not moved by rows outside the span it judges', () => {
			// The controller reads back from `now` and the dashboard from tomorrow's
			// UTC boundary, so one of them holds a day the other does not. The
			// predicate clamps to its own span, which is what makes the screen and the
			// controller unable to disagree — verified from BOTH sides of the bound.
			const beyond = DAY - DEFERRAL_TELEMETRY_SPAN_MS;
			const oldest = beyond + DAY_MS;
			const outside = [
				asBucket(bucketRow({ periodStart: beyond, shardKey: 1, sent: 5_000, deferred: 500 })),
			];
			expect(hasUsableDeferralTelemetry([...sendingOn([0]), ...outside], DAY)).toBe(false);
			expect(
				hasUsableDeferralTelemetry(
					[...sendingOn([0]), asBucket(bucketRow({ periodStart: oldest, shardKey: 2, sent: 10 }))],
					DAY
				)
			).toBe(true);
			// A row dated after today is a clock fault, and must not manufacture the
			// spread that ends the hold.
			expect(
				hasUsableDeferralTelemetry(
					[
						...sendingOn([0]),
						asBucket(bucketRow({ periodStart: DAY + 20 * DAY_MS, shardKey: 3, sent: 10 })),
					],
					DAY
				)
			).toBe(false);
		});

		it('needs traffic, not merely rows, and a readable clock', () => {
			// A bucket carrying no sends says nothing about the counter's silence.
			expect(
				hasUsableDeferralTelemetry(
					[
						...sendingOn([0]),
						asBucket(bucketRow({ periodStart: DAY - 25 * DAY_MS, shardKey: 3, sent: 0 })),
					],
					DAY
				)
			).toBe(false);
			// An unreadable clock cannot be the thing that unlocks a ramp.
			expect(hasUsableDeferralTelemetry(sendingOn([0, 20]), Number.NaN)).toBe(false);
		});
	});

	it('is unaffected by the order the shards arrive in', () => {
		const buckets = [
			asBucket(bucketRow({ periodStart: DAY, shardKey: 7, sent: 3, delivered: 1 })),
			asBucket(bucketRow({ periodStart: DAY, shardKey: 2, sent: 5, delivered: 4 })),
		];
		expect(summarizeTransportOutcomeBuckets(buckets)).toEqual(
			summarizeTransportOutcomeBuckets([...buckets].reverse())
		);
	});
});

describe('summarizeTransportOutcomes (reader-typed, over real rows)', () => {
	it('sums every shard the writer spread events across', async () => {
		const t = convexTest(schema, modules);
		const events = TRANSPORT_OUTCOME_SHARD_COUNT * 12;
		await t.run(async (ctx) => {
			for (let i = 0; i < events; i += 1) {
				await recordTransportOutcomeForCell(ctx, {
					organizationId: OUTCOME_ORG,
					cell: GMAIL_CAMPAIGN_CELL,
					arm: 'own',
					event: 'delivered',
					isCalibration: false,
				});
			}
		});

		await t.run(async (ctx) => {
			const rows = await ctx.db.query('transportOutcomes').collect();
			// The point of the shard split: many rows, one answer.
			expect(rows.length).toBeGreaterThan(1);
			const summary = await summarizeTransportOutcomes(ctx.db, {
				organizationId: OUTCOME_ORG,
				cell: GMAIL_CAMPAIGN_CELL,
				arm: 'own',
			});
			expect(summary.delivered).toBe(events);
		});
	});

	it('gives the arm pair and a single-arm read the identical numbers', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'transportOutcomes',
				bucketRow({
					periodStart: startOfDayUtc(Date.now()),
					shardKey: 1,
					sent: 200,
					delivered: 180,
				})
			);
			await ctx.db.insert(
				'transportOutcomes',
				bucketRow({
					periodStart: startOfDayUtc(Date.now()),
					shardKey: 6,
					sent: 300,
					delivered: 240,
				})
			);
		});

		const { arms, single } = await t.run(async (ctx) => ({
			arms: await summarizeTransportOutcomeArms(ctx.db, {
				organizationId: OUTCOME_ORG,
				cell: GMAIL_CAMPAIGN_CELL,
			}),
			single: await summarizeTransportOutcomes(ctx.db, {
				organizationId: OUTCOME_ORG,
				cell: GMAIL_CAMPAIGN_CELL,
				arm: 'own',
			}),
		}));

		expect(arms.own).toEqual(single);
		expect(arms.own.sent).toBe(500);
		expect(arms.own.deliveryRate).toBeCloseTo(0.84, 10);
		// The other arm of the same cell is a separate, independent window.
		expect(arms.reference.sent).toBe(0);
		expect(arms.reference.deliveryRate).toBe(0);
	});

	it('never mixes arms or cells', async () => {
		const t = convexTest(schema, modules);
		const day = startOfDayUtc(Date.now());
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'transportOutcomes',
				bucketRow({ periodStart: day, shardKey: 0, sent: 10 })
			);
			await ctx.db.insert(
				'transportOutcomes',
				bucketRow({ periodStart: day, shardKey: 0, arm: 'reference', sent: 20 })
			);
			await ctx.db.insert(
				'transportOutcomes',
				bucketRow({ periodStart: day, shardKey: 0, cell: MICROSOFT_CAMPAIGN_CELL, sent: 40 })
			);
		});

		const { gmail, microsoft } = await t.run(async (ctx) => ({
			gmail: await summarizeTransportOutcomeArms(ctx.db, {
				organizationId: OUTCOME_ORG,
				cell: GMAIL_CAMPAIGN_CELL,
			}),
			microsoft: await summarizeTransportOutcomeArms(ctx.db, {
				organizationId: OUTCOME_ORG,
				cell: MICROSOFT_CAMPAIGN_CELL,
			}),
		}));
		expect(gmail.own.sent).toBe(10);
		expect(gmail.reference.sent).toBe(20);
		expect(microsoft.own.sent).toBe(40);
	});

	it('applies the window at the index and in the summarizer alike', async () => {
		const t = convexTest(schema, modules);
		const day = startOfDayUtc(Date.now());
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'transportOutcomes',
				bucketRow({ periodStart: day - 10 * DAY_MS, shardKey: 0, sent: 1000 })
			);
			await ctx.db.insert(
				'transportOutcomes',
				bucketRow({ periodStart: day, shardKey: 0, sent: 7 })
			);
		});

		const recent = await t.run(
			async (ctx) =>
				await summarizeTransportOutcomeArms(ctx.db, {
					organizationId: OUTCOME_ORG,
					cell: GMAIL_CAMPAIGN_CELL,
					since: day - DAY_MS,
					until: day + DAY_MS,
				})
		);
		expect(recent.own.sent).toBe(7);
	});
});
