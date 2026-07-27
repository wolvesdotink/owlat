/**
 * transportOutcomes — the write path (plan D5, ADR-0042 shape).
 *
 * Coverage here:
 *   - the PURE decision core: which counter each event bumps, and which Send
 *     lifecycle transition maps to which outcome event;
 *   - one SHIPPED lifecycle transition bumps exactly ONE shard of exactly ONE
 *     bucket, for every event type the lifecycle can produce;
 *   - the exclusions: `failed` is not a transport outcome, a duplicate
 *     transition records nothing twice, and a send with NO assignment row
 *     (a seed shadow copy, plan D18) never enters a denominator;
 *   - the aging sweep.
 */

import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import {
	recordTransportOutcomeForCell,
	recordTransportOutcomeForSend,
	TRANSPORT_OUTCOME_RETENTION_MS,
} from '../transportOutcomes';
import {
	transportOutcomeCounters,
	transportOutcomeEventForTransition,
	type TransportOutcomeEvent,
} from '../transportOutcomeSummary';
import { startOfDayUtc } from '../sendingReputation';
import { modules } from './testModules';
import {
	bucketRow,
	DAY_MS,
	GMAIL_CAMPAIGN_CELL,
	OUTCOME_ORG,
	readBuckets,
	seedAssignedSend,
	sumCounter,
} from './transportOutcomesFixtures';

// The singleton-org lookup goes through the BetterAuth component, which is not
// registered in the convex-test harness. Same override the shipped routing and
// assignment tests use, so the recorder's org resolution is deterministic.
vi.mock('../../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/sessionOrganization')>();
	// The literal, not the `OUTCOME_ORG` import: `vi.mock` factories are hoisted
	// above the imports, so referencing one here is a TDZ error at load time.
	return { ...actual, getSingletonOrganizationId: vi.fn().mockResolvedValue('org_outcomes') };
});

// The lifecycle schedules webhook fanout and reputation updates via
// `runAfter(0, …)`; let them drain before convex-test's global state is
// replaced, or they surface as "Write outside of transaction" rejections.
afterEach(async () => {
	await new Promise((resolve) => setTimeout(resolve, 25));
});

describe('transportOutcomeEventForTransition (pure)', () => {
	it('maps every lifecycle transition that is a transport outcome', () => {
		expect(transportOutcomeEventForTransition('sent')).toBe('sent');
		expect(transportOutcomeEventForTransition('delivered')).toBe('delivered');
		expect(transportOutcomeEventForTransition('opened')).toBe('opened');
		expect(transportOutcomeEventForTransition('clicked')).toBe('clicked');
		expect(transportOutcomeEventForTransition('complained')).toBe('complained');
		expect(transportOutcomeEventForTransition('bounced', 'hard')).toBe('hard_bounced');
		expect(transportOutcomeEventForTransition('bounced', 'soft')).toBe('soft_bounced');
	});

	it('does not map `failed` — a local non-delivery is not a transport outcome', () => {
		expect(transportOutcomeEventForTransition('failed')).toBeNull();
	});

	it('treats a bounce of unknown hardness as soft (the conservative side)', () => {
		expect(transportOutcomeEventForTransition('bounced')).toBe('soft_bounced');
	});
});

describe('transportOutcomeCounters (pure)', () => {
	const EVENTS: ReadonlyArray<[TransportOutcomeEvent, string]> = [
		['sent', 'sent'],
		['delivered', 'delivered'],
		['deferred', 'deferred'],
		['soft_bounced', 'softBounced'],
		['hard_bounced', 'hardBounced'],
		['complained', 'complained'],
		['opened', 'opened'],
		['clicked', 'clicked'],
		['unsubscribed', 'unsubscribed'],
	];

	it('bumps exactly one general counter per event', () => {
		for (const [event, counter] of EVENTS) {
			expect(transportOutcomeCounters(event, false)).toEqual([counter]);
		}
	});

	it('adds the calibration twin only for the three counters the gate reads', () => {
		expect(transportOutcomeCounters('sent', true)).toEqual(['sent', 'calibrationSent']);
		expect(transportOutcomeCounters('opened', true)).toEqual(['opened', 'calibrationOpened']);
		expect(transportOutcomeCounters('clicked', true)).toEqual(['clicked', 'calibrationClicked']);
	});

	it('keeps a calibration bounce/complaint in the general counter only', () => {
		expect(transportOutcomeCounters('hard_bounced', true)).toEqual(['hardBounced']);
		expect(transportOutcomeCounters('soft_bounced', true)).toEqual(['softBounced']);
		expect(transportOutcomeCounters('complained', true)).toEqual(['complained']);
		expect(transportOutcomeCounters('delivered', true)).toEqual(['delivered']);
	});
});

describe('lifecycle transition → one shard of one bucket', () => {
	async function runTransition(
		status: 'queued' | 'sent' | 'delivered' | 'opened',
		transition:
			| { to: 'sent'; at: number; providerMessageId: string; providerType?: string }
			| { to: 'delivered'; at: number }
			| { to: 'opened'; at: number }
			| { to: 'clicked'; at: number; url: string }
			| { to: 'bounced'; at: number; bounceType: 'hard' | 'soft' }
			| { to: 'complained'; at: number }
			| { to: 'failed'; at: number; errorMessage: string; errorCode: string }
	) {
		const t = convexTest(schema, modules);
		let sendId: Id<'emailSends'> | undefined;
		await t.run(async (ctx) => {
			const seeded = await seedAssignedSend(ctx, { status, assignment: {} });
			sendId = seeded.sendId;
		});
		if (!sendId) throw new Error('seed failed');
		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId },
			transition,
		});
		return await t.run(async (ctx) => await readBuckets(ctx));
	}

	it('records `sent` on queued → sent', async () => {
		const buckets = await runTransition('queued', {
			to: 'sent',
			at: Date.now(),
			providerMessageId: 'pm-sent',
			providerType: 'mta',
		});
		expect(buckets).toHaveLength(1);
		expect(buckets[0]?.organizationId).toBe(OUTCOME_ORG);
		expect(buckets[0]?.cell).toBe(GMAIL_CAMPAIGN_CELL);
		expect(buckets[0]?.arm).toBe('own');
		expect(buckets[0]?.sent).toBe(1);
		expect(buckets[0]?.delivered).toBe(0);
		expect(buckets[0]?.calibrationSent).toBe(0);
	});

	it('records `delivered` on sent → delivered', async () => {
		const buckets = await runTransition('sent', { to: 'delivered', at: Date.now() });
		expect(buckets).toHaveLength(1);
		expect(buckets[0]?.delivered).toBe(1);
		expect(buckets[0]?.sent).toBe(0);
	});

	it('records `opened` on delivered → opened', async () => {
		const buckets = await runTransition('delivered', { to: 'opened', at: Date.now() });
		expect(buckets).toHaveLength(1);
		expect(buckets[0]?.opened).toBe(1);
	});

	it('records `clicked` on opened → clicked', async () => {
		const buckets = await runTransition('opened', {
			to: 'clicked',
			at: Date.now(),
			url: 'https://example.com/offer',
		});
		expect(buckets).toHaveLength(1);
		expect(buckets[0]?.clicked).toBe(1);
	});

	it('records `hard_bounced` on sent → bounced(hard)', async () => {
		const buckets = await runTransition('sent', {
			to: 'bounced',
			at: Date.now(),
			bounceType: 'hard',
		});
		expect(buckets).toHaveLength(1);
		expect(buckets[0]?.hardBounced).toBe(1);
		expect(buckets[0]?.softBounced).toBe(0);
	});

	it('records `soft_bounced` on sent → bounced(soft)', async () => {
		const buckets = await runTransition('sent', {
			to: 'bounced',
			at: Date.now(),
			bounceType: 'soft',
		});
		expect(buckets).toHaveLength(1);
		expect(buckets[0]?.softBounced).toBe(1);
		expect(buckets[0]?.hardBounced).toBe(0);
	});

	it('records `complained` on delivered → complained', async () => {
		const buckets = await runTransition('delivered', { to: 'complained', at: Date.now() });
		expect(buckets).toHaveLength(1);
		expect(buckets[0]?.complained).toBe(1);
	});

	it('records nothing for a `failed` transition', async () => {
		const buckets = await runTransition('queued', {
			to: 'failed',
			at: Date.now(),
			errorMessage: 'connect ETIMEDOUT',
			errorCode: 'timeout',
		});
		expect(buckets).toHaveLength(0);
	});
});

describe('exclusions', () => {
	it('records nothing for a send with no assignment row (the seed shadow-copy seam, D18)', async () => {
		const t = convexTest(schema, modules);
		let sendId: Id<'emailSends'> | undefined;
		await t.run(async (ctx) => {
			// No `assignment` — a seed probe is a shadow copy through the identical
			// composer and transport, never audience membership, so it never gets an
			// assignment row and must never enter a denominator here.
			const seeded = await seedAssignedSend(ctx, { status: 'queued' });
			sendId = seeded.sendId;
		});
		if (!sendId) throw new Error('seed failed');

		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId },
			transition: { to: 'sent', at: Date.now(), providerMessageId: 'pm-probe' },
		});

		await t.run(async (ctx) => {
			expect(await readBuckets(ctx)).toHaveLength(0);
			// …and the send itself still transitioned: measurement degrades, delivery
			// never does.
			expect((await ctx.db.get(sendId!))?.status).toBe('sent');
		});
	});

	it('reports why nothing was recorded instead of throwing', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			const unassigned = await seedAssignedSend(ctx, { status: 'sent' });
			expect(
				await recordTransportOutcomeForSend(ctx, {
					sendId: unassigned.sendId,
					event: 'delivered',
				})
			).toBe('no_assignment');

			const malformed = await seedAssignedSend(ctx, {
				status: 'sent',
				assignment: { cell: 'not-a-cell-key' },
			});
			expect(
				await recordTransportOutcomeForSend(ctx, { sendId: malformed.sendId, event: 'delivered' })
			).toBe('invalid_cell');
			expect(await readBuckets(ctx)).toHaveLength(0);
		});
	});

	it('does not double-count a duplicate transition', async () => {
		const t = convexTest(schema, modules);
		let sendId: Id<'emailSends'> | undefined;
		await t.run(async (ctx) => {
			const seeded = await seedAssignedSend(ctx, { status: 'queued', assignment: {} });
			sendId = seeded.sendId;
		});
		if (!sendId) throw new Error('seed failed');

		const transition = {
			to: 'sent' as const,
			at: Date.now(),
			providerMessageId: 'pm-dupe',
			providerType: 'mta',
		};
		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId },
			transition,
		});
		await t.mutation(internal.delivery.sendLifecycle.transition, {
			send: { kind: 'campaign', id: sendId },
			transition,
		});

		await t.run(async (ctx) => {
			expect(sumCounter(await readBuckets(ctx), 'sent')).toBe(1);
		});
	});
});

describe('the deferral and unsubscribe counters', () => {
	it('records events with no shipped lifecycle source through the same writer', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			for (const event of ['deferred', 'unsubscribed'] as const) {
				await recordTransportOutcomeForCell(ctx, {
					organizationId: OUTCOME_ORG,
					cell: GMAIL_CAMPAIGN_CELL,
					arm: 'own',
					event,
					isCalibration: false,
				});
			}
			const buckets = await readBuckets(ctx);
			expect(sumCounter(buckets, 'deferred')).toBe(1);
			expect(sumCounter(buckets, 'unsubscribed')).toBe(1);
		});
	});
});

describe('aging sweep', () => {
	it('drops buckets past the retention horizon and keeps everything inside it', async () => {
		const t = convexTest(schema, modules);
		const now = startOfDayUtc(Date.now());
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'transportOutcomes',
				bucketRow({ periodStart: now - TRANSPORT_OUTCOME_RETENTION_MS - DAY_MS, shardKey: 0 })
			);
			await ctx.db.insert(
				'transportOutcomes',
				bucketRow({ periodStart: now - TRANSPORT_OUTCOME_RETENTION_MS - 5 * DAY_MS, shardKey: 3 })
			);
			await ctx.db.insert(
				'transportOutcomes',
				bucketRow({ periodStart: now - DAY_MS, shardKey: 1 })
			);
			await ctx.db.insert('transportOutcomes', bucketRow({ periodStart: now, shardKey: 2 }));
		});

		const result = await t.mutation(internal.analytics.transportOutcomes.cleanupExpiredOutcomes, {
			now,
		});
		expect(result.deleted).toBe(2);

		await t.run(async (ctx) => {
			const remaining = await readBuckets(ctx);
			expect(remaining).toHaveLength(2);
			expect(remaining.every((row) => row.periodStart >= now - DAY_MS)).toBe(true);
		});
	});

	it('falls back to the real clock rather than sweeping nothing forever on a NaN clock', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert(
				'transportOutcomes',
				bucketRow({
					periodStart: Date.now() - TRANSPORT_OUTCOME_RETENTION_MS - DAY_MS,
					shardKey: 0,
				})
			);
		});
		const result = await t.mutation(internal.analytics.transportOutcomes.cleanupExpiredOutcomes, {
			now: Number.NaN,
		});
		expect(result.deleted).toBe(1);
	});
});
