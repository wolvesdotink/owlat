/**
 * Reservations (ADR-0073, Phase 1b): concurrent admission stays bounded,
 * reserves are idempotent, holds settle against the ledger (reported usage,
 * a conservative estimate for unknown usage, release when nothing was sent),
 * a crash between dispatch and settlement is settled by the sweep, and an
 * unverifiable reservation state refuses.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../_generated/api';
import { newHarness } from '../../__tests__/testModules';
import { insertLlmUsage } from '../../analytics/ledgerInsert';
import { MAX_OUTSTANDING_HOLDS } from '../admissionState';
import { SETTLEMENT_FEATURE } from '../settlement';
import { aggregateTotals, reconcileSpend } from './spend.testlib';

const USD = 1_000_000;

afterEach(() => {
	vi.unstubAllEnvs();
});

async function ready(dailyUsd: string) {
	vi.stubEnv('AI_SPEND_DAILY_BUDGET_USD', dailyUsd);
	const t = newHarness();
	await reconcileSpend(t);
	return t;
}

function hold(id: string, heldMicrousd: number, over: Record<string, unknown> = {}) {
	return {
		reservationId: id,
		rootRequestId: `postbox_action:${id}`,
		plane: 'language' as const,
		task: 'mail.ask' as const,
		budgetClass: 'standard' as const,
		priority: 'pipeline' as const,
		heldMicrousd,
		maxRequests: 2,
		requestBound: { microusd: Math.ceil(heldMicrousd / 2) },
		modelId: 'gpt-4o',
		expiresAt: Date.now() + 60_000,
		...over,
	};
}

const holds = (t: ReturnType<typeof newHarness>) =>
	t.run((ctx) => ctx.db.query('llmReservations').collect());

describe('aiRouting.admission.reserve', () => {
	it('admits concurrent holds only up to the headroom', async () => {
		// $1 a day: standard work may hold up to $0.90 (the triage allowance is kept).
		const t = await ready('1');
		const results = await Promise.all(
			Array.from({ length: 6 }, (_, index) =>
				t.mutation(internal.aiRouting.admission.reserve, hold(`r${index}`, 0.2 * USD))
			)
		);
		expect(results.filter((result) => result.isAdmitted)).toHaveLength(4);
		expect(results.filter((result) => !result.isAdmitted)).toHaveLength(2);
		const held = (await holds(t)).filter((row) => row.status === 'held');
		expect(held.reduce((sum, row) => sum + row.heldMicrousd, 0)).toBeLessThanOrEqual(0.9 * USD);
	});

	it('is idempotent by reservation id', async () => {
		const t = await ready('10');
		const first = await t.mutation(internal.aiRouting.admission.reserve, hold('same', USD));
		const again = await t.mutation(internal.aiRouting.admission.reserve, hold('same', USD));
		expect(first).toEqual({ isAdmitted: true, isHeld: true });
		expect(again).toEqual({ isAdmitted: true, isHeld: true });
		expect(await holds(t)).toHaveLength(1);
	});

	it('holds nothing, and reads nothing, with no ceiling configured (today)', async () => {
		const t = newHarness();
		// Not even reconciled: with nothing to bound, the state is not read.
		const result = await t.mutation(internal.aiRouting.admission.reserve, hold('free', USD));
		expect(result).toEqual({ isAdmitted: true, isHeld: false });
		expect(await holds(t)).toHaveLength(0);
	});

	it('refuses while the aggregate is unreconciled, and starts the reconcile', async () => {
		vi.stubEnv('AI_SPEND_DAILY_BUDGET_USD', '10');
		const t = newHarness();
		const result = await t.mutation(internal.aiRouting.admission.reserve, hold('early', 1));
		expect(result).toEqual({
			isAdmitted: false,
			reason: 'spend_unverifiable',
			limit: 'unverifiable',
		});
		const scheduled = await t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect());
		expect(scheduled.some((job) => job.name.includes('ensureReconciled'))).toBe(true);
	});

	it('refuses when the outstanding holds cannot be read in one transaction', async () => {
		const t = await ready('1000000');
		await t.run(async (ctx) => {
			for (let index = 0; index <= MAX_OUTSTANDING_HOLDS; index++) {
				const { maxRequests: _maxRequests, requestBound, ...row } = hold(`bulk${index}`, 1);
				await ctx.db.insert('llmReservations', {
					...row,
					requestBounds: [requestBound],
					maxAttempts: 1,
					status: 'held',
					policyVersion: 0,
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
			}
		});
		const result = await t.mutation(internal.aiRouting.admission.reserve, hold('one-more', 1));
		expect(result).toMatchObject({ isAdmitted: false, reason: 'spend_unverifiable' });
	});

	it('refuses a negative or fractional amount', async () => {
		const t = await ready('10');
		expect(await t.mutation(internal.aiRouting.admission.reserve, hold('bad', 0.5))).toMatchObject({
			isAdmitted: false,
			reason: 'spend_unverifiable',
		});
	});
});

describe('settling a hold', () => {
	async function rowUnder(
		t: ReturnType<typeof newHarness>,
		reservationId: string,
		usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null,
		attempt: number
	) {
		await t.run(async (ctx) => {
			await insertLlmUsage(
				ctx,
				'postbox_ask_thread',
				usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
				'gpt-4o',
				undefined,
				{ reservationId, requestId: `req-${reservationId}`, attempt, isEstimated: usage === null }
			);
		});
	}

	it('settles at the reported usage and frees the headroom', async () => {
		const t = await ready('10');
		await t.mutation(internal.aiRouting.admission.reserve, hold('ok', 2 * USD));
		// 100k in + 10k out on gpt-4o: $0.25 + $0.10.
		await rowUnder(
			t,
			'ok',
			{ promptTokens: 100_000, completionTokens: 10_000, totalTokens: 110_000 },
			1
		);
		await t.mutation(internal.aiRouting.admission.settle, {
			reservationId: 'ok',
			expectedRequests: 1,
		});
		const [row] = await holds(t);
		expect(row).toMatchObject({ status: 'settled', settledMicrousd: 350_000 });
		expect((await aggregateTotals(t)).day).toBe(350_000);
	});

	it('charges a request with unknown usage one request’s share of the hold, in the ledger', async () => {
		const t = await ready('10');
		await t.mutation(internal.aiRouting.admission.reserve, hold('lost', 2 * USD));
		await rowUnder(t, 'lost', null, 1);
		await t.mutation(internal.aiRouting.admission.settle, {
			reservationId: 'lost',
			expectedRequests: 1,
		});
		const [row] = await holds(t);
		// maxRequests 2 → one request's share is $1.
		expect(row).toMatchObject({ status: 'settled', settledMicrousd: USD });
		const estimate = await t.run((ctx) =>
			ctx.db
				.query('llmUsageEvents')
				.withIndex('by_reservation_id', (q) => q.eq('reservationId', 'lost'))
				.collect()
		);
		expect(estimate.find((e) => e.feature === SETTLEMENT_FEATURE)).toMatchObject({
			costMicrousd: USD,
			isEstimated: true,
			task: 'mail.ask',
		});
		expect((await aggregateTotals(t)).day).toBe(USD);
	});

	it('stays held while some rows are still on their way, and releases a hold that sent nothing', async () => {
		const t = await ready('10');
		await t.mutation(internal.aiRouting.admission.reserve, hold('partial', USD));
		await t.mutation(internal.aiRouting.admission.settle, {
			reservationId: 'partial',
			expectedRequests: 2,
		});
		expect((await holds(t))[0]).toMatchObject({ status: 'held' });

		await t.mutation(internal.aiRouting.admission.reserve, hold('nothing', USD));
		await t.mutation(internal.aiRouting.admission.release, { reservationId: 'nothing' });
		const released = (await holds(t)).find((row) => row.reservationId === 'nothing');
		expect(released).toMatchObject({ status: 'released', settledMicrousd: 0 });
		// Settling again changes nothing.
		await t.mutation(internal.aiRouting.admission.settle, {
			reservationId: 'nothing',
			expectedRequests: 0,
		});
		expect((await aggregateTotals(t)).day).toBe(0);
	});

	it('settles a crash between dispatch and settlement through the sweep, at the whole hold', async () => {
		const t = await ready('10');
		await t.mutation(
			internal.aiRouting.admission.reserve,
			hold('crashed', 3 * USD, { expiresAt: Date.now() - 1 })
		);
		// The action wrote one row ($0.35) and died before settling.
		await rowUnder(
			t,
			'crashed',
			{ promptTokens: 100_000, completionTokens: 10_000, totalTokens: 110_000 },
			1
		);

		await t.mutation(internal.aiRouting.admission.sweepExpiredHolds, {});

		const [row] = await holds(t);
		expect(row).toMatchObject({ status: 'expired', settledMicrousd: 3 * USD });
		// The ledger carries the whole hold: the row plus the conservative rest.
		expect((await aggregateTotals(t)).day).toBe(3 * USD);
		// A late settle from the dead action changes nothing.
		await t.mutation(internal.aiRouting.admission.settle, {
			reservationId: 'crashed',
			expectedRequests: 1,
		});
		expect((await aggregateTotals(t)).day).toBe(3 * USD);
	});

	it('leaves holds that have not expired to their call', async () => {
		const t = await ready('10');
		await t.mutation(internal.aiRouting.admission.reserve, hold('live', USD));
		await t.mutation(internal.aiRouting.admission.sweepExpiredHolds, {});
		expect((await holds(t))[0]).toMatchObject({ status: 'held' });
	});
});

describe('per-request bounds and late rows (Sol r1 F2, F3)', () => {
	const recordRows = (
		t: ReturnType<typeof newHarness>,
		reservationId: string,
		requests: {
			attempt: number;
			usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
		}[]
	) =>
		t.mutation(internal.analytics.llmUsage.recordRequests, {
			feature: 'postbox_ask_thread',
			requestId: 'call-1',
			requests: requests.map((request) => ({
				attempt: request.attempt,
				latencyMs: 1,
				modelUsed: 'gpt-4o',
				reservationId,
				...(request.usage ? { usage: request.usage } : {}),
			})),
		});

	it('charges a request with unknown usage at its own bound, not the average', async () => {
		const t = await ready('10');
		await t.mutation(internal.aiRouting.admission.reserve, {
			...hold('bounded', 0.1 * USD),
			maxRequests: 1,
			requestBound: { requestId: 'call-1', attempt: 1, microusd: 0.1 * USD },
		});
		await t.mutation(internal.aiRouting.admission.extend, {
			reservationId: 'bounded',
			requestBound: { requestId: 'call-1', attempt: 2, microusd: 0.9 * USD },
		});
		// Request 1 reported $0.35; request 2 (the $0.90 one) reported nothing.
		await recordRows(t, 'bounded', [
			{
				attempt: 1,
				usage: { promptTokens: 100_000, completionTokens: 10_000, totalTokens: 110_000 },
			},
			{ attempt: 2 },
		]);
		await t.mutation(internal.aiRouting.admission.settle, {
			reservationId: 'bounded',
			expectedRequests: 2,
		});
		const [row] = await holds(t);
		expect(row).toMatchObject({ status: 'settled', settledMicrousd: 350_000 + 900_000 });
		expect((await aggregateTotals(t)).day).toBe(1_250_000);
	});

	it('charges a request that arrives after the sweep against the estimate: max(estimate, reported)', async () => {
		const t = await ready('10');
		await t.mutation(
			internal.aiRouting.admission.reserve,
			hold('late', USD, { expiresAt: Date.now() - 1 })
		);
		await t.mutation(internal.aiRouting.admission.sweepExpiredHolds, {});
		expect((await aggregateTotals(t)).day).toBe(USD);

		// A $0.35 request lands after the $1 estimate: the estimate already covers it.
		await recordRows(t, 'late', [
			{
				attempt: 1,
				usage: { promptTokens: 100_000, completionTokens: 10_000, totalTokens: 110_000 },
			},
		]);
		expect((await aggregateTotals(t)).day).toBe(USD);
		// A second, $0.70 request: only the part above what is left of the estimate counts.
		await recordRows(t, 'late', [
			{
				attempt: 2,
				usage: { promptTokens: 200_000, completionTokens: 20_000, totalTokens: 220_000 },
			},
		]);
		expect((await aggregateTotals(t)).day).toBe(1_050_000);
		const [row] = await holds(t);
		expect(row).toMatchObject({
			status: 'expired',
			settledMicrousd: 1_050_000,
			estimateRemainingMicrousd: 0,
		});
		// The aggregate is still derivable from the ledger alone.
		await t.run(async (ctx) => {
			const state = await ctx.db.query('llmSpendAggregateState').first();
			await ctx.db.patch(state!._id, { status: 'unreconciled' });
		});
		await reconcileSpend(t);
		expect((await aggregateTotals(t)).day).toBe(1_050_000);
	});

	it('adds nothing for a late row whose usage is unknown', async () => {
		const t = await ready('10');
		await t.mutation(
			internal.aiRouting.admission.reserve,
			hold('late-unknown', USD, { expiresAt: Date.now() - 1 })
		);
		await t.mutation(internal.aiRouting.admission.sweepExpiredHolds, {});
		await recordRows(t, 'late-unknown', [{ attempt: 1 }]);
		expect((await aggregateTotals(t)).day).toBe(USD);
	});
});
