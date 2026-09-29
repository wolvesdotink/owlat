/**
 * `mtaHealth.record` writes the `mtaHealth` counter row the Delivery surfaces
 * subscribe to, so a poll that only refreshed timestamps must not write it until
 * the stored snapshot needs a re-stamp. It never writes the documents feature
 * gates read (plan 2.4).
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it } from 'vitest';
import type { Infer } from 'convex/values';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { mtaHealthSnapshotValidator } from '../../schema/instance';
import {
	canSkipMtaHealthWrite,
	MTA_HEALTH_MAX_AGE_MS,
	MTA_HEALTH_RESTAMP_MS,
	MTA_HEALTH_SYNC_INTERVAL_MS,
} from '../mtaHealthFreshness';

// Same glob-merge shape as healthRollup.test.ts: re-add the sibling
// `delivery/*` modules under the root-relative keys convex-test expects.
const rootGlob = import.meta.glob('../../**/*.*s');
const deliveryGlob = Object.fromEntries(
	Object.entries(import.meta.glob('../**/*.*s')).map(([path, mod]) => [
		path.replace(/^\.\.\//, '../../delivery/'),
		mod,
	])
);
const modules = { ...rootGlob, ...deliveryGlob };

type Snapshot = Infer<typeof mtaHealthSnapshotValidator>;

const T0 = 1_800_000_000_000;

/** A healthy poll at `at`; the MTA stamps both probes with the poll time. */
function poll(at: number, overrides: Partial<Snapshot> = {}): Snapshot {
	return {
		status: 'ok',
		isRedisConnected: true,
		isWorkerAlive: true,
		isDnsReachable: true,
		isAllIpsBlocked: false,
		smtpOutbound: {
			status: 'ok',
			checkedAt: at - 30_000,
			ips: [{ ip: '203.0.113.10', status: 'ok', sourceBinding: 'bound' }],
		},
		smtpTls: {
			status: 'pass',
			hostname: 'mail.owlat.app',
			isHostnameMatched: true,
			validTo: T0 + 90 * 86_400_000,
			checkedAt: at,
		},
		observedAt: at,
		...overrides,
	};
}

async function stored(t: TestConvex<typeof schema>) {
	return await t.run(
		async (ctx) =>
			await ctx.db
				.query('instanceCounters')
				.withIndex('by_key', (q) => q.eq('key', 'mtaHealth'))
				.first()
	);
}

describe('mtaHealth.record', () => {
	it('never patches the settings or flag documents the gates read', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', { createdAt: T0, updatedAt: T0 });
			await ctx.db.insert('featureFlagSettings', { featureFlags: {}, updatedAt: T0 });
		});
		const gateDocs = () =>
			t.run(async (ctx) => ({
				settings: await ctx.db.query('instanceSettings').first(),
				flags: await ctx.db.query('featureFlagSettings').first(),
			}));
		const before = await gateDocs();

		await t.mutation(internal.delivery.mtaHealth.record, { snapshot: poll(T0) });
		await t.mutation(internal.delivery.mtaHealth.record, {
			snapshot: poll(T0 + MTA_HEALTH_SYNC_INTERVAL_MS, { status: 'degraded' }),
		});

		expect(await gateDocs()).toEqual(before);
		expect((await stored(t))?.mtaHealth?.status).toBe('degraded');
	});

	it('carries on from a snapshot stored on instanceSettings before the split', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', { mtaHealth: poll(T0), createdAt: T0 });
		});

		// A repeat of the legacy snapshot is still skipped: the fallback read sees it.
		await t.mutation(internal.delivery.mtaHealth.record, {
			snapshot: poll(T0 + MTA_HEALTH_SYNC_INTERVAL_MS),
		});
		expect(await stored(t)).toBeNull();
	});

	it('skips a poll that repeats the stored snapshot inside the re-stamp interval', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(internal.delivery.mtaHealth.record, { snapshot: poll(T0) });
		const first = await stored(t);

		await t.mutation(internal.delivery.mtaHealth.record, {
			snapshot: poll(T0 + MTA_HEALTH_SYNC_INTERVAL_MS),
		});

		const after = await stored(t);
		expect(after?.mtaHealth?.observedAt).toBe(T0);
		expect(after?.updatedAt).toBe(first?.updatedAt);
	});

	it('writes a changed signal straight away', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(internal.delivery.mtaHealth.record, { snapshot: poll(T0) });

		const later = T0 + MTA_HEALTH_SYNC_INTERVAL_MS;
		await t.mutation(internal.delivery.mtaHealth.record, {
			snapshot: poll(later, { status: 'degraded', isWorkerAlive: false }),
		});

		const after = await stored(t);
		expect(after?.mtaHealth?.status).toBe('degraded');
		expect(after?.mtaHealth?.observedAt).toBe(later);
	});

	it('writes a failed probe IP and an unreachable MTA straight away', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(internal.delivery.mtaHealth.record, { snapshot: poll(T0) });

		const later = T0 + MTA_HEALTH_SYNC_INTERVAL_MS;
		await t.mutation(internal.delivery.mtaHealth.record, {
			snapshot: poll(later, {
				smtpOutbound: {
					status: 'degraded',
					checkedAt: later,
					ips: [{ ip: '203.0.113.10', status: 'failed', reason: 'timeout' }],
				},
			}),
		});
		expect((await stored(t))?.mtaHealth?.smtpOutbound?.ips[0]?.status).toBe('failed');

		const unreachableAt = later + MTA_HEALTH_SYNC_INTERVAL_MS;
		await t.mutation(internal.delivery.mtaHealth.record, {
			snapshot: { status: 'unreachable', observedAt: unreachableAt },
		});
		const after = await stored(t);
		expect(after?.mtaHealth).toEqual({ status: 'unreachable', observedAt: unreachableAt });
	});

	it('re-stamps an unchanged snapshot once the re-stamp interval has passed', async () => {
		const t = convexTest(schema, modules);
		await t.mutation(internal.delivery.mtaHealth.record, { snapshot: poll(T0) });

		const restampAt = T0 + MTA_HEALTH_RESTAMP_MS;
		await t.mutation(internal.delivery.mtaHealth.record, { snapshot: poll(restampAt) });

		const after = await stored(t);
		expect(after?.mtaHealth?.observedAt).toBe(restampAt);
		expect(after?.mtaHealth?.smtpTls?.checkedAt).toBe(restampAt);
	});
});

describe('canSkipMtaHealthWrite', () => {
	it('ignores field order and the probe timestamps, nothing else', () => {
		const stored = poll(T0);
		// The stored document need not keep the key order the poll was built with.
		const reverseKeys = (value: unknown): unknown =>
			Array.isArray(value)
				? value.map(reverseKeys)
				: value !== null && typeof value === 'object'
					? Object.fromEntries(
							Object.entries(value)
								.reverse()
								.map(([key, member]) => [key, reverseKeys(member)])
						)
					: value;
		const reordered = reverseKeys(poll(T0 + 60_000)) as Snapshot;
		expect(canSkipMtaHealthWrite(stored, reordered)).toBe(true);
		expect(
			canSkipMtaHealthWrite(
				stored,
				poll(T0 + 60_000, { smtpTls: { ...poll(T0).smtpTls!, status: 'warn' } })
			)
		).toBe(false);
		expect(canSkipMtaHealthWrite(undefined, stored)).toBe(false);
	});

	it('keeps a skipped snapshot fresh for readers until the next re-stamp is overdue', () => {
		// The last skip happens just before the re-stamp interval; the re-stamp
		// lands on the following poll. Readers must still call that snapshot fresh
		// with two polls missed on top.
		const worstCaseAge = MTA_HEALTH_RESTAMP_MS + 3 * MTA_HEALTH_SYNC_INTERVAL_MS;
		expect(MTA_HEALTH_MAX_AGE_MS).toBeGreaterThanOrEqual(worstCaseAge);
	});
});
