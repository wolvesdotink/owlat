/**
 * The `deferred` transport outcome — the emitter (plan D5/D10).
 *
 * Three claims, and the third is the reason the piece exists:
 *
 *   1. a last-mile deferral reaches the (cell, arm) counter THROUGH THE REAL
 *      WRITER — the workpool completion callback, the lifecycle effect runner
 *      and the assignment join, with nothing stubbed in between;
 *   2. it counts ONCE per send per UTC DAY, however many times the router
 *      re-defers the same message;
 *   3. with that counter written, gate 2 reaches a verdict — including its
 *      10% fail and its 25% halt — on traffic where it previously read
 *      `safeRate(0)` and passed, which is a gate that could not fail.
 *
 * The pure event→counter map lives in `analytics/__tests__/
 * transportOutcomesEvents.test.ts`; the gate cascade in `ramp/__tests__/`.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { WorkId } from '@convex-dev/workpool';
import type { MutationCtx } from '../../_generated/server';
import type { Id } from '../../_generated/dataModel';
import type { DeliverabilityCellKey } from '@owlat/shared/deliverabilityRouting';
import { modules } from '../../__tests__/testModules';
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
	seedAssignedTestPreview,
	sumCounters,
	uniqueBucketKeys,
	drainOutcomeWrites,
} from '../../analytics/__tests__/transportOutcomesFixtures';
import { recordDeferralOutcome } from '../deferralOutcome';
import { resolveMtaRoutingDecision } from '../../lib/sendProviders/mta';
import { resolveSendTransport } from '../../lib/sendProviders/transports';
import { evaluateDeferralGate } from '../ramp/gates';
import { RAMP_GATE_SAMPLE_FLOORS, RAMP_GATE_THRESHOLDS } from '../ramp/gateConfig';
import { input, NOW } from '../ramp/__tests__/gateFixtures';

// The singleton-org lookup goes through the BetterAuth component, which is not
// registered in the convex-test harness. Same override the sibling outcome
// suites use, so the recorder's org resolution is deterministic.
vi.mock('../../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/sessionOrganization')>();
	// The literal, not the `OUTCOME_ORG` import: `vi.mock` factories are hoisted
	// above the imports, so referencing one here is a TDZ error at load time.
	return { ...actual, getSingletonOrganizationId: vi.fn().mockResolvedValue('org_outcomes') };
});

const testWorkId = 'test-work-id' as WorkId;

/**
 * The worker result a last-mile deferral produces (`governedDispatch.ts`).
 *
 * `retryState` present means the completion callback re-enqueues the send;
 * omitting it is the exhausted case, where the same observation ends in a
 * terminal `failed` instead.
 */
function deferredResult(
	sendId: Id<'emailSends'>,
	options: { readonly retryable?: boolean; readonly origin?: 'governed' | 'local' } = {}
) {
	const retry = options.retryable ?? true;
	return {
		kind: 'success' as const,
		returnValue: {
			success: false,
			deferred: true,
			deferralOrigin: options.origin ?? ('governed' as const),
			retryAfterMs: 60_000,
			...(retry
				? {
						envelopeInput: { kind: 'campaign' },
						retryState: { attempt: 1, startedAt: Date.now(), idempotencyKey: `send_${sendId}` },
					}
				: {}),
		},
	};
}

async function completeDeferred(
	t: ReturnType<typeof convexTest>,
	sendId: Id<'emailSends'>,
	options: { readonly retryable?: boolean; readonly origin?: 'governed' | 'local' } = {}
): Promise<void> {
	await t.mutation(internal.delivery.sendCompletion.completeSend, {
		workId: testWorkId,
		result: deferredResult(sendId, options),
		context: { sendRef: { kind: 'campaign', id: sendId } },
	});
	await drainOutcomeWrites(t);
}

/**
 * The origin the SHIPPED ADAPTER derives for one MTA defer reason.
 *
 * The cases below feed this straight into the completion callback instead of
 * typing `'local'` in themselves: the classification is the thing that
 * regressed, so a test that asserts it and then hand-feeds the answer to the
 * counter would pass on either side of the bug.
 */
async function originFromMta(reason: string): Promise<'governed' | 'local'> {
	vi.stubEnv('MTA_API_URL', 'https://mta.test');
	vi.stubEnv('MTA_API_KEY', 'test-key');
	const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
		new Response(JSON.stringify({ decision: 'defer', reason, retryAfterMs: 60_000 }), {
			status: 200,
		})
	);
	try {
		const decision = await resolveMtaRoutingDecision(resolveSendTransport('mta'), {
			messageId: 'send-1',
			workAttemptId: 'work-1',
			routingReentryToken: 'reentry-1',
			startedAt: NOW,
			deliveryDomain: 'production',
			messageType: 'campaign',
			organizationId: OUTCOME_ORG,
			recipient: 'person@gmail.com',
			from: 'sender@example.org',
			candidateProvider: 'mta',
			ipPool: 'campaign',
			allowWarmupOverflow: false,
		});
		if (decision.kind !== 'defer') throw new Error(`expected a deferral, got ${decision.kind}`);
		return decision.origin;
	} finally {
		fetchSpy.mockRestore();
		vi.unstubAllEnvs();
	}
}

/** The recorder, called directly so a case can name the INSTANT it observes. */
async function recordAt(
	t: ReturnType<typeof convexTest>,
	sendId: Id<'emailSends'>,
	at: number
): Promise<string> {
	const result = await t.run(
		async (ctx) =>
			await recordDeferralOutcome(ctx as MutationCtx, {
				send: { kind: 'campaign', id: sendId },
				at,
			})
	);
	await drainOutcomeWrites(t);
	return result;
}

describe('a last-mile deferral reaches the counter through the real writer', () => {
	it('bumps the cell/arm deferred counter from the completion callback', async () => {
		const t = convexTest(schema, modules);
		const { sendId } = await t.run(async (ctx) => await seedAssignedSend(ctx, { assignment: {} }));

		await completeDeferred(t, sendId);

		await t.run(async (ctx) => {
			const buckets = await readBuckets(ctx);
			expect(uniqueBucketKeys(buckets)).toHaveLength(1);
			// The WHOLE counter set: a deferral landing on any other column, or on
			// none, has to fail this.
			expect(sumCounters(buckets)).toEqual({ ...ZERO_TRANSPORT_OUTCOME_TOTALS, deferred: 1 });
			expect(buckets[0]?.arm).toBe('own');
			expect(buckets[0]?.cell).toBe(GMAIL_CAMPAIGN_CELL);
			// A deferred send is still ours to deliver: the observation must not
			// terminalize it, and the retry is still armed.
			const send = await ctx.db.get(sendId);
			expect(send?.status).toBe('queued');
			expect(send?.deferralCountedDay).toBe(startOfDayUtc(Date.now()));
			// NAMED, not counted: the outcome bump is scheduled out of the transition
			// now, so it rides beside the re-entry — and any pending job would satisfy
			// a bare count.
			const scheduled = await ctx.db.system.query('_scheduled_functions').collect();
			expect(scheduled.filter((job) => job.name.includes('retrySend'))).toHaveLength(1);
		});
	});

	it('counts the deferral that runs out of attempts, which is the one that fails the send', async () => {
		const t = convexTest(schema, modules);
		const { sendId } = await t.run(async (ctx) => await seedAssignedSend(ctx, { assignment: {} }));

		// No retry state: the callback cannot re-enqueue, so this deferral is the
		// last thing that happened to the message. It is still a deferral.
		await completeDeferred(t, sendId, { retryable: false });

		await t.run(async (ctx) => {
			expect(sumCounters(await readBuckets(ctx))).toEqual({
				...ZERO_TRANSPORT_OUTCOME_TOTALS,
				deferred: 1,
			});
			expect((await ctx.db.get(sendId))?.status).toBe('failed');
		});
	});

	it('records nothing for a completion that was not a deferral', async () => {
		const t = convexTest(schema, modules);
		const { sendId } = await t.run(async (ctx) => await seedAssignedSend(ctx, { assignment: {} }));

		await t.mutation(internal.delivery.sendCompletion.completeSend, {
			workId: testWorkId,
			result: {
				kind: 'success',
				returnValue: { success: true, providerMessageId: 'msg-1', providerType: 'mta' },
			},
			context: { sendRef: { kind: 'campaign', id: sendId } },
		});
		await drainOutcomeWrites(t);

		await t.run(async (ctx) => {
			// `sent` — from the lifecycle transition, not from this emitter.
			expect(sumCounters(await readBuckets(ctx))).toEqual({
				...ZERO_TRANSPORT_OUTCOME_TOTALS,
				sent: 1,
			});
			expect((await ctx.db.get(sendId))?.deferralCountedDay).toBeUndefined();
		});
	});

	it('attributes to the arm and the cell the assignment row names', async () => {
		const t = convexTest(schema, modules);
		const { sendId } = await t.run(
			async (ctx) =>
				await seedAssignedSend(ctx, {
					assignment: { arm: 'reference', cell: MICROSOFT_CAMPAIGN_CELL },
				})
		);

		await completeDeferred(t, sendId);

		await t.run(async (ctx) => {
			const buckets = await readBuckets(ctx);
			expect(buckets[0]?.arm).toBe('reference');
			expect(buckets[0]?.cell).toBe(MICROSOFT_CAMPAIGN_CELL);
			expect(sumCounters(buckets).deferred).toBe(1);
		});
	});
});

describe('one deferral per send per UTC day', () => {
	it('collapses a retry storm inside one day into a single event', async () => {
		const t = convexTest(schema, modules);
		const { sendId } = await t.run(async (ctx) => await seedAssignedSend(ctx, { assignment: {} }));

		expect(await recordAt(t, sendId, NOW)).toBe('observed');
		// The same message, deferred again an hour later and again at the end of the
		// UTC day: the numerator is denominated on `sent`, and a send that could
		// contribute a dozen events would push it past its own denominator.
		expect(await recordAt(t, sendId, NOW + 60 * 60 * 1000)).toBe('already_observed_today');
		expect(await recordAt(t, sendId, startOfDayUtc(NOW) + DAY_MS - 1)).toBe(
			'already_observed_today'
		);

		await t.run(async (ctx) => {
			expect(sumCounters(await readBuckets(ctx)).deferred).toBe(1);
		});
	});

	it('counts again the next UTC day — a send still held tomorrow is tomorrow’s evidence', async () => {
		const t = convexTest(schema, modules);
		const { sendId } = await t.run(async (ctx) => await seedAssignedSend(ctx, { assignment: {} }));

		expect(await recordAt(t, sendId, NOW)).toBe('observed');
		expect(await recordAt(t, sendId, NOW + DAY_MS)).toBe('observed');

		await t.run(async (ctx) => {
			const buckets = await readBuckets(ctx);
			expect(sumCounters(buckets).deferred).toBe(2);
			// Two DAYS, not two events in one bucket: the rate is derived per window
			// and the day the outcome was recorded is the bucket it belongs to.
			expect(uniqueBucketKeys(buckets)).toHaveLength(2);
			expect((await ctx.db.get(sendId))?.deferralCountedDay).toBe(startOfDayUtc(NOW + DAY_MS));
		});
	});

	it('is per SEND, not per cell: two held messages are two events', async () => {
		const t = convexTest(schema, modules);
		const sends = await t.run(async (ctx) => [
			(await seedAssignedSend(ctx, { assignment: {} })).sendId,
			(await seedAssignedSend(ctx, { assignment: {} })).sendId,
		]);

		for (const sendId of sends) expect(await recordAt(t, sendId, NOW)).toBe('observed');

		await t.run(async (ctx) => {
			expect(sumCounters(await readBuckets(ctx)).deferred).toBe(2);
		});
	});
});

describe('what is excluded records nothing, and says so', () => {
	it('a send with no assignment row is not telemetry — but its day is still processed', async () => {
		const t = convexTest(schema, modules);
		// No `assignment`: the seed-probe seam (plan D18), and any send outside the
		// experiment.
		const { sendId } = await t.run(async (ctx) => await seedAssignedSend(ctx));

		expect(await recordAt(t, sendId, NOW)).toBe('observed');

		await t.run(async (ctx) => {
			expect(await readBuckets(ctx)).toHaveLength(0);
			// The observation WAS processed for this send and day, so the next
			// re-entry cannot go looking for a second one.
			expect((await ctx.db.get(sendId))?.deferralCountedDay).toBe(startOfDayUtc(NOW));
		});
	});

	it('a test preview keeps its lifecycle and stays out of the arm denominators', async () => {
		const t = convexTest(schema, modules);
		// Seeded WITH an assignment row on purpose: the exclusion under test is the
		// preview rule, not the unrelated "no assignment" one.
		const previewId = await t.run(async (ctx) => await seedAssignedTestPreview(ctx));

		const result = await t.run(
			async (ctx) =>
				await recordDeferralOutcome(ctx as MutationCtx, {
					send: { kind: 'transactional', id: previewId },
					at: NOW,
				})
		);

		expect(result).toBe('observed');
		await drainOutcomeWrites(t);
		await t.run(async (ctx) => {
			expect(await readBuckets(ctx)).toHaveLength(0);
			expect((await ctx.db.get(previewId))?.deferralCountedDay).toBe(startOfDayUtc(NOW));
		});
	});

	it('a send deleted between the worker answering and the callback running is a no-op', async () => {
		const t = convexTest(schema, modules);
		const { sendId } = await t.run(async (ctx) => await seedAssignedSend(ctx, { assignment: {} }));
		await t.run(async (ctx) => {
			await ctx.db.delete(sendId);
		});

		expect(await recordAt(t, sendId, NOW)).toBe('send_missing');
		await t.run(async (ctx) => {
			expect(await readBuckets(ctx)).toHaveLength(0);
		});
	});

	it('a send that terminalized during the race is not counted against its own sent row', async () => {
		const t = convexTest(schema, modules);
		// A concurrent MTA acceptance moved the send to `sent` between the worker
		// answering `defer` and this callback running. That send is already in the
		// `sent` denominator gate 2 divides by; adding it to the numerator too would
		// let one message be both.
		const { sendId } = await t.run(
			async (ctx) => await seedAssignedSend(ctx, { assignment: {}, status: 'sent' })
		);

		expect(await recordAt(t, sendId, NOW)).toBe('send_not_queued');
		await t.run(async (ctx) => {
			expect(await readBuckets(ctx)).toHaveLength(0);
			// Not stamped either: the day was never this send's to take.
			expect((await ctx.db.get(sendId))?.deferralCountedDay).toBeUndefined();
		});
	});
});

/**
 * WHOSE FAULT THE DEFERRAL WAS (`LastMileRoutingDeferred.origin`).
 *
 * Gate 2 halts a cell at 25% — share to the floor, cooldown, graduation pin
 * revoked. An MTA decision endpoint that is unreachable for forty minutes defers
 * every message in the window on OUR side, which is a fault no receiver saw, and
 * a fortnight of penalty for it is not a measurement.
 */
describe('only the governed half of a deferral is gate 2 evidence', () => {
	it('counts the deferral the MTA governance decided', async () => {
		const t = convexTest(schema, modules);
		const { sendId } = await t.run(async (ctx) => await seedAssignedSend(ctx, { assignment: {} }));

		await completeDeferred(t, sendId, { origin: 'governed' });

		await t.run(async (ctx) => {
			expect(sumCounters(await readBuckets(ctx)).deferred).toBe(1);
		});
	});

	it('records nothing for the deployment holding its own message', async () => {
		const t = convexTest(schema, modules);
		const { sendId } = await t.run(async (ctx) => await seedAssignedSend(ctx, { assignment: {} }));

		// A policy hold, or an unreachable decision endpoint: same `deferred: true`
		// to the retry machinery, and the send is still re-enqueued below.
		await completeDeferred(t, sendId, { origin: 'local' });

		await t.run(async (ctx) => {
			expect(await readBuckets(ctx)).toHaveLength(0);
			const send = await ctx.db.get(sendId);
			expect(send?.status).toBe('queued');
			// UNSTAMPED, so the day stays available: if the same message is deferred
			// by the receiver an hour later, that one still counts.
			expect(send?.deferralCountedDay).toBeUndefined();
			// NAMED, not counted: this case records no outcome, so the re-entry has to
			// be identified by name rather than by being the only job in the table.
			const scheduled = await ctx.db.system.query('_scheduled_functions').collect();
			expect(scheduled.filter((job) => job.name.includes('retrySend'))).toHaveLength(1);
		});
	});

	it('records nothing when the MTA fails to persist a lease it already granted', async () => {
		const t = convexTest(schema, modules);
		const { sendId } = await t.run(async (ctx) => await seedAssignedSend(ctx, { assignment: {} }));

		// `lease_persistence` is a Redis WRITE FAILURE on our own MTA — the lease was
		// granted and then could not be stored. An hour of that is our storage layer
		// down, not a receiver refusing this identity, and gate 2 halts a cell at
		// 25%. The origin comes from the adapter so this pins the classification and
		// the counting together.
		await completeDeferred(t, sendId, { origin: await originFromMta('lease_persistence') });

		await t.run(async (ctx) => {
			expect(await readBuckets(ctx)).toHaveLength(0);
			const send = await ctx.db.get(sendId);
			expect(send?.status).toBe('queued');
			expect(send?.deferralCountedDay).toBeUndefined();
		});
	});

	it('still counts the safety-circuit deferral that arrives by the same route', async () => {
		const t = convexTest(schema, modules);
		const { sendId } = await t.run(async (ctx) => await seedAssignedSend(ctx, { assignment: {} }));

		// The companion to the case above: same adapter, same callback, a reason
		// that IS about the sending identity. Without it, an adapter that answered
		// `local` to everything would satisfy the exclusion and silence the gate.
		await completeDeferred(t, sendId, { origin: await originFromMta('global_safety') });

		await t.run(async (ctx) => {
			expect(sumCounters(await readBuckets(ctx)).deferred).toBe(1);
		});
	});

	it('records nothing for a deferral that names no origin at all', async () => {
		const t = convexTest(schema, modules);
		const { sendId } = await t.run(async (ctx) => await seedAssignedSend(ctx, { assignment: {} }));

		// An in-flight worker running the previous build answers without the field.
		// An unlabelled deferral is not counted rather than guessed at — the halt is
		// the expensive direction to be wrong in.
		await t.mutation(internal.delivery.sendCompletion.completeSend, {
			workId: testWorkId,
			result: {
				kind: 'success',
				returnValue: {
					success: false,
					deferred: true,
					retryAfterMs: 60_000,
					envelopeInput: { kind: 'campaign' },
					retryState: { attempt: 1, startedAt: Date.now(), idempotencyKey: `send_${sendId}` },
				},
			},
			context: { sendRef: { kind: 'campaign', id: sendId } },
		});
		await drainOutcomeWrites(t);

		await t.run(async (ctx) => {
			expect(await readBuckets(ctx)).toHaveLength(0);
			expect((await ctx.db.get(sendId))?.status).toBe('queued');
		});
	});
});

/**
 * THE REGRESSION THIS PIECE IS ABOUT.
 *
 * Gate 2 is the ramp's fast signal and the only gate that can HALT a cell. With
 * no writer for its numerator, `deferred / sent` was `0` on every deployment
 * forever: the 10% ceiling and the 25% halt line were unreachable, and the pass
 * they produced instead was `increaseEvidence` — a gate that could only ever
 * agree with raising the share.
 *
 * The deferrals below are written by the emitter, one real send each. The `sent`
 * denominator underneath them is seeded as bucket rows: producing 200 sends
 * through the lifecycle per case would test the lifecycle, and the gate reads
 * that column only to decide the window is large enough to speak about.
 */
describe('gate 2 can finally fail, halt, and hold', () => {
	const SENT = RAMP_GATE_SAMPLE_FLOORS.deferral;
	const WINDOW = { since: NOW - DAY_MS, until: NOW + 1 };

	async function seedWindowVolume(
		t: ReturnType<typeof convexTest>,
		cell: DeliverabilityCellKey
	): Promise<void> {
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'transportOutcomes',
				bucketRow({ cell, periodStart: startOfDayUtc(NOW), shardKey: 0, sent: SENT })
			);
		});
	}

	/** `count` distinct held messages in `cell`, each recorded by the emitter. */
	async function deferMany(
		t: ReturnType<typeof convexTest>,
		cell: DeliverabilityCellKey,
		count: number
	): Promise<void> {
		for (let i = 0; i < count; i += 1) {
			const { sendId } = await t.run(
				async (ctx) => await seedAssignedSend(ctx, { assignment: { cell } })
			);
			await recordAt(t, sendId, NOW);
		}
	}

	async function verdict(t: ReturnType<typeof convexTest>, cell: DeliverabilityCellKey) {
		return await t.run(async (ctx) => {
			const own = await summarizeTransportOutcomes(ctx.db, {
				organizationId: OUTCOME_ORG,
				cell,
				arm: 'own',
				...WINDOW,
			});
			return {
				own,
				// The reader's instrumentation observation is deliberately NOT supplied:
				// these cells are judged on what the emitter actually wrote.
				result: evaluateDeferralGate(input({ own, now: NOW })),
			};
		});
	}

	it('fails past the 10% ceiling, halts at 25%, and holds the cell nothing wrote to', async () => {
		const t = convexTest(schema, modules);
		await seedWindowVolume(t, GMAIL_CAMPAIGN_CELL);
		await seedWindowVolume(t, MICROSOFT_CAMPAIGN_CELL);

		// One send over the ceiling — the smallest breach the emitter can express.
		const overCeiling = Math.floor(SENT * (RAMP_GATE_THRESHOLDS.deferralMax as number)) + 1;
		await deferMany(t, GMAIL_CAMPAIGN_CELL, overCeiling);
		const failing = await verdict(t, GMAIL_CAMPAIGN_CELL);
		expect(failing.own.deferred).toBe(overCeiling);
		expect(failing.result.status).toBe('fail');
		expect(failing.result.reason).toBe('absolute_threshold_breached');

		// The same cell, taken to the halt line by more of the same writes.
		const atHalt = Math.ceil(SENT * (RAMP_GATE_THRESHOLDS.deferralHalt as number));
		await deferMany(t, GMAIL_CAMPAIGN_CELL, atHalt - overCeiling);
		const halting = await verdict(t, GMAIL_CAMPAIGN_CELL);
		expect(halting.own.deferred).toBe(atHalt);
		expect(halting.result.status).toBe('halt');
		expect(halting.result.reason).toBe('halt_threshold_breached');

		// And the cell as it looked before this piece: the same ample window, every
		// other counter written, this one empty. It reads 0% — and is no longer
		// allowed to call that a pass.
		const unwritten = await verdict(t, MICROSOFT_CAMPAIGN_CELL);
		expect(unwritten.own.deferred).toBe(0);
		expect(unwritten.own.sent).toBe(SENT);
		expect(unwritten.result.status).toBe('insufficient_data');
		expect(unwritten.result.reason).toBe('own_deferral_telemetry_absent');
	});

	it('one emitted deferral is enough to make a healthy cell decidable again', async () => {
		const t = convexTest(schema, modules);
		await seedWindowVolume(t, GMAIL_CAMPAIGN_CELL);
		await deferMany(t, GMAIL_CAMPAIGN_CELL, 1);

		const measured = await verdict(t, GMAIL_CAMPAIGN_CELL);
		expect(measured.own.deferred).toBe(1);
		expect(measured.result.status).toBe('pass');
		expect(measured.result.mayJustifyIncrease).toBe(true);
	});
});
