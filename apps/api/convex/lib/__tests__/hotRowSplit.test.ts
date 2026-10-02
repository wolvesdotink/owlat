/**
 * Feature flags and counters no longer share a document (plan 2.4).
 *
 * Every gate reads the flag map; counters and telemetry are written on contact
 * inserts, inbound messages, sends and MTA polls. These tests pin that the
 * counter writers touch neither `instanceSettings` nor `featureFlagSettings`,
 * that flag reads and writes go to the dedicated singleton, and that values
 * stored on `instanceSettings` before the split are read (and carried on) until
 * `migrations/0046_split_hot_rows` has copied them.
 */

import { convexTest, type TestConvex } from 'convex-test';
import { describe, expect, it } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { modules } from '../../__tests__/testModules';
import { getStoredFlags } from '../featureFlags';
import { readFeatureFlagSettings, writeFeatureFlagSettings } from '../featureFlagSettings';
import { readInstanceCounter } from '../instanceCounters';
import {
	decrementContactCount,
	getCachedContactCount,
	incrementContactCount,
} from '../contactCountHelpers';
import { applyInboxStatsDelta, applyOpenThreadDelta } from '../inboxStats';
import { countFacet } from '../listing';
import { contactListing } from '../../contacts/listing';

type Test = TestConvex<typeof schema>;

const T0 = 1_800_000_000_000;

async function gateDocs(t: Test) {
	return await t.run(async (ctx) => ({
		settings: await ctx.db.query('instanceSettings').first(),
		flags: await ctx.db.query('featureFlagSettings').first(),
	}));
}

async function counterRow(t: Test, key: 'contacts' | 'inbox' | 'sends') {
	return await t.run(
		async (ctx) =>
			await ctx.db
				.query('instanceCounters')
				.withIndex('by_key', (q) => q.eq('key', key))
				.first()
	);
}

describe('counter writers', () => {
	it('contact and inbox counter writes never patch the documents gates read', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', { createdAt: T0, updatedAt: T0 });
			await ctx.db.insert('featureFlagSettings', { featureFlags: { inbox: true }, updatedAt: T0 });
		});
		const before = await gateDocs(t);

		await t.run(async (ctx) => {
			await incrementContactCount(ctx, 3);
			await decrementContactCount(ctx);
			await applyInboxStatsDelta(ctx, null, 'received');
			await applyInboxStatsDelta(ctx, 'received', 'processing');
			await applyOpenThreadDelta(ctx, 1);
		});
		await t.mutation(internal.delivery.status.recordTestResult, { at: T0 + 5 });

		expect(await gateDocs(t)).toEqual(before);
		expect((await counterRow(t, 'contacts'))?.contactCount).toBe(2);
		const inbox = await counterRow(t, 'inbox');
		expect(inbox?.inboxStats).toMatchObject({ received: 0, processing: 1, total: 1 });
		expect(inbox?.openThreads).toBe(1);
		const deliveryTest = await t.run((ctx) => readInstanceCounter(ctx.db, 'deliveryTest'));
		expect(deliveryTest.deliveryTestLastSucceededAt).toBe(T0 + 5);
	});

	it('reads and carries on from counters stored on instanceSettings before the split', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				contactCount: 7,
				openThreads: 4,
				inboxStats: {
					received: 2,
					processing: 0,
					draftReady: 0,
					approved: 0,
					sent: 0,
					quarantined: 0,
					failed: 0,
					rejected: 0,
					archived: 0,
					total: 2,
				},
				createdAt: T0,
			});
		});
		const before = await gateDocs(t);

		// Before any write, readers see the legacy values.
		expect(await t.run((ctx) => getCachedContactCount(ctx))).toBe(7);
		expect(await t.run((ctx) => countFacet(ctx.db, contactListing, 'total'))).toBe(7);

		await t.run(async (ctx) => {
			await incrementContactCount(ctx);
			await applyInboxStatsDelta(ctx, null, 'received');
			await applyOpenThreadDelta(ctx, -1);
		});

		expect(await t.run((ctx) => getCachedContactCount(ctx))).toBe(8);
		expect(await t.run((ctx) => countFacet(ctx.db, contactListing, 'total'))).toBe(8);
		const inbox = await counterRow(t, 'inbox');
		expect(inbox?.inboxStats).toMatchObject({ received: 3, total: 3 });
		expect(inbox?.openThreads).toBe(3);
		// The legacy columns are no longer written.
		expect(await gateDocs(t)).toEqual(before);
	});

	it('keeps inbox counters and decrements as no-ops before the instance exists', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await applyInboxStatsDelta(ctx, null, 'received');
			await applyOpenThreadDelta(ctx, 1);
			await decrementContactCount(ctx);
		});
		expect(await counterRow(t, 'inbox')).toBeNull();
		expect(await counterRow(t, 'contacts')).toBeNull();
	});
});

describe('feature flag singleton', () => {
	it('falls back to the instanceSettings columns until the singleton exists', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				featureFlags: { inbox: true },
				pluginCapabilityGrants: { 'plugin.demo': { 'mail:read': true } },
				createdAt: T0,
			});
		});
		expect(await t.run((ctx) => getStoredFlags(ctx))).toEqual({ inbox: true });
	});

	it('a flag write seeds the singleton from the legacy columns and mirrors onto them', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				featureFlags: { inbox: true },
				pluginCapabilityGrants: { 'plugin.demo': { 'mail:read': true } },
				createdAt: T0,
			});
			await writeFeatureFlagSettings(ctx, { featureFlags: { inbox: false } });
		});

		const { settings, flags } = await gateDocs(t);
		expect(flags?.featureFlags).toEqual({ inbox: false });
		expect(flags?.pluginCapabilityGrants).toEqual({ 'plugin.demo': { 'mail:read': true } });
		expect(settings?.featureFlags).toEqual({ inbox: false });

		// Once the singleton exists, the legacy column is no longer consulted.
		await t.run(async (ctx) => {
			const row = await ctx.db.query('instanceSettings').first();
			await ctx.db.patch(row!._id, { featureFlags: { inbox: true } });
		});
		const stored = await t.run((ctx) => readFeatureFlagSettings(ctx.db));
		expect(stored.featureFlags).toEqual({ inbox: false });
	});
});

describe('0046 backfill', () => {
	it('copies flags and counters once and never overwrites a newer row', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('instanceSettings', {
				featureFlags: { inbox: true },
				contactCount: 11,
				transactionalSendCount: 5,
				dailySendCount: 2,
				dailySendCountResetAt: T0,
				deliveryTestLastSucceededAt: T0,
				mtaHealth: { status: 'ok', observedAt: T0 },
				createdAt: T0,
			});
			// Written after the deploy, before the backfill: must survive it.
			await ctx.db.insert('instanceCounters', {
				key: 'contacts',
				contactCount: 12,
				updatedAt: T0 + 1,
			});
		});

		const run = internal.migrations['0046_split_hot_rows'].run;
		expect(await t.action(run, {})).toEqual({
			featureFlagSettings: true,
			// Every key but the existing `contacts` row, `imapLegacy` included: a
			// family added after the split gets an empty row.
			counters: 5,
			mailboxUsage: 0,
		});
		const read = <K extends 'contacts' | 'sends' | 'mtaHealth' | 'deliveryTest'>(key: K) =>
			t.run((ctx) => readInstanceCounter(ctx.db, key));
		expect((await read('contacts')).contactCount).toBe(12);
		expect(await read('sends')).toEqual({
			transactionalSendCount: 5,
			dailySendCount: 2,
			dailySendCountResetAt: T0,
		});
		expect((await read('mtaHealth')).mtaHealth).toEqual({ status: 'ok', observedAt: T0 });
		expect((await read('deliveryTest')).deliveryTestLastSucceededAt).toBe(T0);
		expect((await gateDocs(t)).flags?.featureFlags).toEqual({ inbox: true });

		expect(await t.action(run, {})).toEqual({
			featureFlagSettings: false,
			counters: 0,
			mailboxUsage: 0,
		});
	});
});
