/**
 * transportOutcomes — the OCC lesson (ADR-0042's post-mortem, plan D16).
 *
 * `sendingReputation` originally read-modify-wrote ONE daily document per send
 * event and `.collect()`-ed the whole window inline; a campaign blast turned
 * that into a write hotspot plus read amplification. This table is the same
 * shape on a hotter path, so the two properties that fix are asserted here
 * BEHAVIOURALLY rather than by reading the source:
 *
 *   1. concurrent recordings across shards lose no counts, and
 *   2. the write path issues NO wide read — no `.collect()`, and every query it
 *      does make is an index point read.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import type { MutationCtx } from '../../_generated/server';
import {
	recordTransportOutcomeForCell,
	recordTransportOutcomeForSend,
	summarizeTransportOutcomes,
	TRANSPORT_OUTCOME_SHARD_COUNT,
} from '../transportOutcomes';
import { modules } from '../../__tests__/testModules';
import { GMAIL_CAMPAIGN_CELL, OUTCOME_ORG, seedAssignedSend } from './transportOutcomesFixtures';

vi.mock('../../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/sessionOrganization')>();
	// The literal, not the `OUTCOME_ORG` import: `vi.mock` factories are hoisted
	// above the imports, so referencing one here is a TDZ error at load time.
	return { ...actual, getSingletonOrganizationId: vi.fn().mockResolvedValue('org_outcomes') };
});

interface ReadCounters {
	collects: number;
	fullScans: number;
	indexedQueries: number;
}

/**
 * Wrap a query builder so terminal reads are counted and every chained call
 * keeps the wrapper. `withIndex` is what separates a point read from a scan, so
 * a query that reaches `.collect()` WITHOUT one is recorded as a full scan.
 */
function wrapQuery(query: object, counters: ReadCounters, indexed: boolean): object {
	return new Proxy(query, {
		get(target, prop, receiver) {
			const value: unknown = Reflect.get(target, prop, receiver);
			if (typeof value !== 'function') return value;
			const method = value as (...args: unknown[]) => unknown;
			return (...args: unknown[]): unknown => {
				const nextIndexed = indexed || prop === 'withIndex';
				if (prop === 'collect') {
					counters.collects += 1;
					if (!nextIndexed) counters.fullScans += 1;
				}
				const result: unknown = method.apply(target, args);
				return result !== null && typeof result === 'object' && 'collect' in result
					? wrapQuery(result as object, counters, nextIndexed)
					: result;
			};
		},
	});
}

/** A mutation ctx whose reads are counted. Nothing else is changed. */
function instrumentCtx(ctx: MutationCtx, counters: ReadCounters): MutationCtx {
	const db = new Proxy(ctx.db, {
		get(target, prop, receiver) {
			const value: unknown = Reflect.get(target, prop, receiver);
			if (typeof value !== 'function') return value;
			const method = value as (...args: unknown[]) => unknown;
			if (prop !== 'query') return method.bind(target);
			return (...args: unknown[]): unknown => {
				counters.indexedQueries += 1;
				return wrapQuery(method.apply(target, args) as object, counters, false);
			};
		},
	});
	return { ...ctx, db } as MutationCtx;
}

describe('transportOutcomes write path — contention', () => {
	it('loses no counts when many events land on the same cell concurrently', async () => {
		const t = convexTest(schema, modules);
		const events = 120;

		// Each `t.run` is its own transaction, so these are genuinely concurrent
		// writers against one (org, cell, arm, day) bucket — the exact shape that
		// made the unsharded reputation table contend.
		await Promise.all(
			Array.from({ length: events }, async () =>
				t.run(
					async (ctx) =>
						await recordTransportOutcomeForCell(ctx, {
							organizationId: OUTCOME_ORG,
							cell: GMAIL_CAMPAIGN_CELL,
							arm: 'own',
							event: 'sent',
							isCalibration: false,
						})
				)
			)
		);

		await t.run(async (ctx) => {
			const summary = await summarizeTransportOutcomes(ctx.db, {
				organizationId: OUTCOME_ORG,
				cell: GMAIL_CAMPAIGN_CELL,
				arm: 'own',
			});
			expect(summary.sent).toBe(events);

			// …and they really did spread: a single-row hotspot would show one shard.
			const rows = await ctx.db.query('transportOutcomes').collect();
			expect(rows.length).toBeGreaterThan(1);
			expect(rows.length).toBeLessThanOrEqual(TRANSPORT_OUTCOME_SHARD_COUNT);
			expect(new Set(rows.map((row) => row.shardKey)).size).toBe(rows.length);
		});
	});

	it('does no wide read on the hot path, however many buckets already exist', async () => {
		const t = convexTest(schema, modules);
		let sendId: string | undefined;
		await t.run(async (ctx) => {
			const seeded = await seedAssignedSend(ctx, { status: 'sent', assignment: {} });
			sendId = seeded.sendId;
			// Pre-existing history the writer must not read.
			for (let day = 1; day <= 40; day += 1) {
				for (let shard = 0; shard < TRANSPORT_OUTCOME_SHARD_COUNT; shard += 1) {
					await ctx.db.insert('transportOutcomes', {
						organizationId: OUTCOME_ORG,
						cell: GMAIL_CAMPAIGN_CELL,
						arm: 'own',
						periodStart: Date.now() - day * 24 * 60 * 60 * 1000,
						shardKey: shard,
						sent: 1,
						delivered: 1,
						deferred: 0,
						softBounced: 0,
						hardBounced: 0,
						complained: 0,
						opened: 0,
						clicked: 0,
						unsubscribed: 0,
						calibrationSent: 0,
						calibrationOpened: 0,
						calibrationClicked: 0,
						lastRecordedAt: Date.now(),
					});
				}
			}
		});
		if (sendId === undefined) throw new Error('seed failed');
		const assignedSendId = sendId;

		const counters: ReadCounters = { collects: 0, fullScans: 0, indexedQueries: 0 };
		await t.run(async (ctx) => {
			const result = await recordTransportOutcomeForSend(instrumentCtx(ctx, counters), {
				sendId: assignedSendId,
				event: 'delivered',
			});
			expect(result).toBe('recorded');
		});

		// Two indexed point reads: the assignment join and the shard bucket.
		// Zero `.collect()` calls — the whole point.
		expect(counters.collects).toBe(0);
		expect(counters.fullScans).toBe(0);
		expect(counters.indexedQueries).toBe(2);
	});
});
