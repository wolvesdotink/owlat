import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../_generated/api';
import schema from '../../schema';
import {
	RETURN_PATH_PROBE_RETRY_SCHEDULE_MS,
	RETURN_PATH_PROBE_TIMEOUT_MS,
	RETURN_PATH_PROBE_TTL_MS,
} from '../../lib/sendProviders/returnPathCapability';
import { returnPathProbeMessageId } from '../messageIdRouting';
import { returnPathCapabilityFor } from '../relayReturnPath';

/**
 * Integration half of G-08's capability detection: the probe verdict is
 * persisted against the CONFIGURED TRANSPORT and read back by the send path.
 * Real table writes through the convex-test harness.
 *
 * The clock is FAKE and the fixtures are relative to it. A fixed absolute T0
 * would be a future timestamp on some CI runs and a stale one 30 days later —
 * both of which change the answers, because a verdict decays after its TTL and
 * a verdict from the future is refused as clock skew.
 */

const rootGlob = import.meta.glob('../../**/*.*s');
const deliveryGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, module]) => [
		path.replace(/^\.\.\//, '../../delivery/'),
		module,
	])
);
const modules = { ...rootGlob, ...deliveryGlob };

const TRANSPORT_ID = 'smtp';
const SENT = 'bounce+cHJvYmU+bWFj@bounces.example.com';
const PROBE_ID = 'probe-1';
const T0 = Date.UTC(2026, 6, 27, 8, 0, 0);

beforeEach(() => {
	// Only the CLOCK is faked — convex-test drives real promises/timers.
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

async function submit(t: ReturnType<typeof convexTest>, accepted = true) {
	return await t.mutation(internal.delivery.relayReturnPath.recordProbeSubmission, {
		transportId: TRANSPORT_ID,
		probeId: PROBE_ID,
		sentEnvelopeSender: SENT,
		accepted,
		at: Date.now(),
	});
}

/**
 * Reads the capability at the CURRENT (faked) clock, through the SAME resolver
 * the routing pass calls — there is no second read seam to drift from.
 */
async function capability(t: ReturnType<typeof convexTest>) {
	return await t.run(async (ctx) => await returnPathCapabilityFor(ctx, TRANSPORT_ID, Date.now()));
}

describe('relay return-path probe persistence', () => {
	it('an unprobed transport reads as unknown, degraded, and stamps nothing', async () => {
		const t = convexTest(schema, modules);
		const resolved = await capability(t);
		expect(resolved.capability).toBe('unknown');
		expect(resolved.stampVerpReturnPath).toBe(false);
		expect(resolved.degraded).toBe(true);
	});

	it('acceptance keeps the verdict open — it does NOT enable the stamp', async () => {
		const t = convexTest(schema, modules);
		expect((await submit(t)).status).toBe('awaiting_delivery');
		const resolved = await capability(t);
		expect(resolved.capability).toBe('unknown');
		expect(resolved.stampVerpReturnPath).toBe(false);
	});

	it('an observed bounce for the probe records supported and enables the stamp', async () => {
		const t = convexTest(schema, modules);
		await submit(t);
		vi.setSystemTime(T0 + 60_000);
		const applied = await t.mutation(internal.delivery.relayReturnPath.recordProbeObservation, {
			probeMessageId: returnPathProbeMessageId(PROBE_ID),
			at: Date.now(),
		});
		expect(applied).toMatchObject({ applied: true, status: 'supported' });
		const resolved = await capability(t);
		expect(resolved.capability).toBe('supported');
		expect(resolved.stampVerpReturnPath).toBe(true);
		expect(resolved.measurement).toBe('comparable');
	});

	it('a supported verdict DECAYS back to unknown once its TTL passes', async () => {
		const t = convexTest(schema, modules);
		await submit(t);
		await t.mutation(internal.delivery.relayReturnPath.recordProbeObservation, {
			probeMessageId: returnPathProbeMessageId(PROBE_ID),
			at: Date.now(),
		});
		expect((await capability(t)).stampVerpReturnPath).toBe(true);
		vi.setSystemTime(T0 + RETURN_PATH_PROBE_TTL_MS);
		expect((await capability(t)).stampVerpReturnPath).toBe(false);
	});

	it('ADVERSARIAL: a relay that accepts then REWRITES the sender goes SILENT', async () => {
		// This is what an accept-then-rewrite actually looks like from here. Our
		// bounce server only attributes a DSN whose signed VERP token verifies, and
		// the MAC covers the local part — so a relay that rewrote (or case-folded)
		// the envelope sender sends its DSN somewhere we never see. There is no
		// mismatching observation to receive: the probe simply never gets one, ages
		// out, and is graded unsupported. Acceptance never becomes a verdict.
		const t = convexTest(schema, modules);
		expect((await submit(t, true)).status).toBe('awaiting_delivery');
		expect((await capability(t)).stampVerpReturnPath).toBe(false);

		vi.setSystemTime(T0 + RETURN_PATH_PROBE_TIMEOUT_MS);
		const { expired } = await t.mutation(
			internal.delivery.relayReturnPath.expireTimedOutProbes,
			{}
		);
		expect(expired).toBe(1);
		const resolved = await capability(t);
		expect(resolved.capability).toBe('unsupported');
		expect(resolved.reason).toBe('no_bounce_observed');
		expect(resolved.stampVerpReturnPath).toBe(false);
		expect(resolved.degraded).toBe(true);
	});

	it('a refused MAIL FROM settles unsupported at submission time', async () => {
		const t = convexTest(schema, modules);
		expect((await submit(t, false)).status).toBe('unsupported');
		expect((await capability(t)).stampVerpReturnPath).toBe(false);
	});

	it('an observation for an unknown probe is a no-op, not an error', async () => {
		const t = convexTest(schema, modules);
		const applied = await t.mutation(internal.delivery.relayReturnPath.recordProbeObservation, {
			probeMessageId: returnPathProbeMessageId('never-sent'),
			at: Date.now(),
		});
		expect(applied).toMatchObject({ applied: false, reason: 'probe_not_found' });
	});

	it('a non-probe message id is rejected without touching anything', async () => {
		const t = convexTest(schema, modules);
		const applied = await t.mutation(internal.delivery.relayReturnPath.recordProbeObservation, {
			probeMessageId: 'ordinary-send-id',
			at: Date.now(),
		});
		expect(applied).toMatchObject({ applied: false, reason: 'not_a_probe' });
	});

	it('a second observation for a settled probe is a no-op', async () => {
		const t = convexTest(schema, modules);
		await submit(t);
		await t.mutation(internal.delivery.relayReturnPath.recordProbeObservation, {
			probeMessageId: returnPathProbeMessageId(PROBE_ID),
			at: Date.now(),
		});
		const again = await t.mutation(internal.delivery.relayReturnPath.recordProbeObservation, {
			probeMessageId: returnPathProbeMessageId(PROBE_ID),
			at: Date.now() + 1,
		});
		expect(again).toMatchObject({ applied: false, reason: 'already_settled' });
	});

	it('rejects a transport id nothing resolves, rather than persisting it', async () => {
		const t = convexTest(schema, modules);
		const result = await t.mutation(internal.delivery.relayReturnPath.recordProbeSubmission, {
			transportId: 'not-a-transport',
			probeId: 'probe-x',
			sentEnvelopeSender: SENT,
			accepted: true,
			at: Date.now(),
		});
		expect(result).toEqual({ ok: false, reason: 'unresolvable_transport' });
		const rows = await t.run(
			async (ctx) => await ctx.db.query('sendTransportReturnPathProbes').collect()
		);
		expect(rows).toHaveLength(0);
		expect(
			await t.query(internal.delivery.relayReturnPath.isReturnPathProbeDue, {
				transportId: 'not-a-transport',
				at: Date.now(),
			})
		).toBe(false);
	});

	it('keeps ONE row per transport — a re-probe replaces the previous verdict', async () => {
		const t = convexTest(schema, modules);
		await submit(t);
		await t.mutation(internal.delivery.relayReturnPath.recordProbeSubmission, {
			transportId: TRANSPORT_ID,
			probeId: 'probe-2',
			sentEnvelopeSender: SENT,
			accepted: true,
			at: Date.now() + 1_000,
		});
		const rows = await t.run(
			async (ctx) => await ctx.db.query('sendTransportReturnPathProbes').collect()
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.probeId).toBe('probe-2');
		// Attempts accumulate across re-probes — the backoff is driven by them.
		expect(rows[0]?.attempts).toBe(2);
	});

	it('expires an open probe that never saw a bounce', async () => {
		const t = convexTest(schema, modules);
		await submit(t);
		const { expired } = await t.mutation(internal.delivery.relayReturnPath.expireTimedOutProbes, {
			at: T0 + RETURN_PATH_PROBE_TIMEOUT_MS,
		});
		expect(expired).toBe(1);
		vi.setSystemTime(T0 + RETURN_PATH_PROBE_TIMEOUT_MS);
		const resolved = await capability(t);
		expect(resolved.capability).toBe('unsupported');
		expect(resolved.reason).toBe('no_bounce_observed');
	});

	it('the expiry sweep leaves settled probes alone', async () => {
		const t = convexTest(schema, modules);
		await submit(t, false); // settled unsupported at submission
		const { expired } = await t.mutation(internal.delivery.relayReturnPath.expireTimedOutProbes, {
			at: T0 + RETURN_PATH_PROBE_TIMEOUT_MS * 10,
		});
		expect(expired).toBe(0);
	});

	it('re-probe scheduling is answered from the stored verdict', async () => {
		const t = convexTest(schema, modules);
		expect(
			await t.query(internal.delivery.relayReturnPath.isReturnPathProbeDue, {
				transportId: TRANSPORT_ID,
				at: T0,
			})
		).toBe(true);
		await submit(t);
		expect(
			await t.query(internal.delivery.relayReturnPath.isReturnPathProbeDue, {
				transportId: TRANSPORT_ID,
				at: T0 + 1,
			})
		).toBe(false);
	});

	it('BACKS OFF a relay that keeps refusing — one bounce a month, not one a day', async () => {
		const t = convexTest(schema, modules);
		const [first, second] = RETURN_PATH_PROBE_RETRY_SCHEDULE_MS;
		await submit(t, false);
		const due = async (at: number) =>
			await t.query(internal.delivery.relayReturnPath.isReturnPathProbeDue, {
				transportId: TRANSPORT_ID,
				at,
			});
		expect(await due(T0 + first - 1)).toBe(false);
		expect(await due(T0 + first)).toBe(true);

		// Second refusal: the interval widens rather than staying daily.
		await t.mutation(internal.delivery.relayReturnPath.recordProbeSubmission, {
			transportId: TRANSPORT_ID,
			probeId: 'probe-2',
			sentEnvelopeSender: SENT,
			accepted: false,
			at: T0 + first,
		});
		expect(await due(T0 + first + first)).toBe(false);
		expect(await due(T0 + first + second)).toBe(true);
	});
});

describe('a scheduled RE-PROBE never switches off the stamp it is confirming', () => {
	/** Drive one transport all the way to a persisted `supported` verdict. */
	async function prove(t: ReturnType<typeof convexTest>) {
		await submit(t);
		await t.mutation(internal.delivery.relayReturnPath.recordProbeObservation, {
			probeMessageId: returnPathProbeMessageId(PROBE_ID),
			at: Date.now(),
		});
	}

	it('keeps stamping across the TTL re-probe, and resets the backoff count', async () => {
		const t = convexTest(schema, modules);
		await prove(t);
		expect((await capability(t)).stampVerpReturnPath).toBe(true);

		// 30 days later the verdict is due a re-check; the sweep reopens the row.
		const reprobeAt = T0 + RETURN_PATH_PROBE_TTL_MS;
		vi.setSystemTime(reprobeAt);
		expect(
			await t.query(internal.delivery.relayReturnPath.isReturnPathProbeDue, {
				transportId: TRANSPORT_ID,
				at: Date.now(),
			})
		).toBe(true);
		await t.mutation(internal.delivery.relayReturnPath.recordProbeSubmission, {
			transportId: TRANSPORT_ID,
			probeId: 'probe-2',
			sentEnvelopeSender: SENT,
			accepted: true,
			at: Date.now(),
		});

		// The whole point: relayed bounces during the re-probe window stay
		// attributable, and the cell does not silently flip to degraded.
		const during = await capability(t);
		expect(during.capability).toBe('supported');
		expect(during.stampVerpReturnPath).toBe(true);
		expect(during.degraded).toBe(false);

		const [row] = await t.run(
			async (ctx) => await ctx.db.query('sendTransportReturnPathProbes').collect()
		);
		expect(row?.status).toBe('awaiting_delivery');
		expect(row?.lastSettled).toMatchObject({ status: 'supported', reason: 'observed_match' });
		// A relay proven a moment ago starts its backoff over, so the day it
		// breaks it gets the documented next-day retry, not the 30d cap.
		expect(row?.attempts).toBe(1);
	});

	it('the re-probe REPLACES the carried verdict once it settles', async () => {
		const t = convexTest(schema, modules);
		await prove(t);
		const reprobeAt = T0 + RETURN_PATH_PROBE_TTL_MS;
		vi.setSystemTime(reprobeAt);
		await t.mutation(internal.delivery.relayReturnPath.recordProbeSubmission, {
			transportId: TRANSPORT_ID,
			probeId: 'probe-2',
			sentEnvelopeSender: SENT,
			accepted: true,
			at: Date.now(),
		});

		// The relay has broken: no bounce ever arrives and the probe ages out.
		vi.setSystemTime(reprobeAt + RETURN_PATH_PROBE_TIMEOUT_MS);
		const { expired } = await t.mutation(internal.delivery.relayReturnPath.expireTimedOutProbes, {
			at: Date.now(),
		});
		expect(expired).toBe(1);

		const resolved = await capability(t);
		expect(resolved.capability).toBe('unsupported');
		expect(resolved.reason).toBe('no_bounce_observed');
		expect(resolved.stampVerpReturnPath).toBe(false);
		const [row] = await t.run(
			async (ctx) => await ctx.db.query('sendTransportReturnPathProbes').collect()
		);
		// The carry is spent — a settled row's own status IS the verdict.
		expect(row?.lastSettled).toBeUndefined();
	});

	it('a MAIL FROM refusal on the re-probe clears the carry immediately', async () => {
		const t = convexTest(schema, modules);
		await prove(t);
		vi.setSystemTime(T0 + RETURN_PATH_PROBE_TTL_MS);
		await t.mutation(internal.delivery.relayReturnPath.recordProbeSubmission, {
			transportId: TRANSPORT_ID,
			probeId: 'probe-2',
			sentEnvelopeSender: SENT,
			accepted: false,
			at: Date.now(),
		});
		const resolved = await capability(t);
		expect(resolved.capability).toBe('unsupported');
		expect(resolved.reason).toBe('rejected_by_relay');
		const [row] = await t.run(
			async (ctx) => await ctx.db.query('sendTransportReturnPathProbes').collect()
		);
		expect(row?.lastSettled).toBeUndefined();
	});
});
