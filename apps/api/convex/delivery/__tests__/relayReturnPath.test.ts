import { convexTest } from 'convex-test';
import { describe, expect, it } from 'vitest';
import { internal } from '../../_generated/api';
import schema from '../../schema';
import { RETURN_PATH_PROBE_TIMEOUT_MS } from '../../lib/sendProviders/returnPathCapability';
import { returnPathProbeMessageId } from '../relayReturnPath';

/**
 * Integration half of G-08's capability detection: the probe verdict is
 * persisted against the CONFIGURED TRANSPORT and read back by the send path.
 * Real table writes through the convex-test harness.
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

async function submit(t: ReturnType<typeof convexTest>, accepted = true) {
	return await t.mutation(internal.delivery.relayReturnPath.recordProbeSubmission, {
		transportId: TRANSPORT_ID,
		probeId: PROBE_ID,
		sentEnvelopeSender: SENT,
		accepted,
		at: T0,
	});
}

async function capability(t: ReturnType<typeof convexTest>) {
	return await t.query(internal.delivery.relayReturnPath.transportReturnPathCapability, {
		transportId: TRANSPORT_ID,
	});
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
		const applied = await t.mutation(internal.delivery.relayReturnPath.recordProbeObservation, {
			probeMessageId: returnPathProbeMessageId(PROBE_ID),
			at: T0 + 60_000,
		});
		expect(applied).toMatchObject({ applied: true, status: 'supported' });
		const resolved = await capability(t);
		expect(resolved.capability).toBe('supported');
		expect(resolved.stampVerpReturnPath).toBe(true);
		expect(resolved.measurement).toBe('comparable');
	});

	it('ADVERSARIAL: an observed REWRITTEN sender records unsupported', async () => {
		const t = convexTest(schema, modules);
		await submit(t);
		const applied = await t.mutation(internal.delivery.relayReturnPath.recordProbeObservation, {
			probeMessageId: returnPathProbeMessageId(PROBE_ID),
			observedEnvelopeSender: 'bounces@relay-provider.example',
			at: T0 + 60_000,
		});
		expect(applied).toMatchObject({ applied: true, status: 'unsupported' });
		const resolved = await capability(t);
		expect(resolved.capability).toBe('unsupported');
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
			at: T0,
		});
		expect(applied).toMatchObject({ applied: false, reason: 'probe_not_found' });
	});

	it('a non-probe message id is rejected without touching anything', async () => {
		const t = convexTest(schema, modules);
		const applied = await t.mutation(internal.delivery.relayReturnPath.recordProbeObservation, {
			probeMessageId: 'ordinary-send-id',
			at: T0,
		});
		expect(applied).toMatchObject({ applied: false, reason: 'not_a_probe' });
	});

	it('keeps ONE row per transport — a re-probe replaces the previous verdict', async () => {
		const t = convexTest(schema, modules);
		await submit(t);
		await t.mutation(internal.delivery.relayReturnPath.recordProbeSubmission, {
			transportId: TRANSPORT_ID,
			probeId: 'probe-2',
			sentEnvelopeSender: SENT,
			accepted: true,
			at: T0 + 1_000,
		});
		const rows = await t.run(
			async (ctx) => await ctx.db.query('sendTransportReturnPathProbes').collect()
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.probeId).toBe('probe-2');
	});

	it('expires an open probe that never saw a bounce', async () => {
		const t = convexTest(schema, modules);
		await submit(t);
		const { expired } = await t.mutation(internal.delivery.relayReturnPath.expireTimedOutProbes, {
			at: T0 + RETURN_PATH_PROBE_TIMEOUT_MS,
		});
		expect(expired).toBe(1);
		const resolved = await capability(t);
		expect(resolved.capability).toBe('unsupported');
		expect(resolved.reason).toBe('no_bounce_observed');
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
});
