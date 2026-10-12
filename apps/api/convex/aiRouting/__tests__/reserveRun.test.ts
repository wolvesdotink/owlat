/**
 * `aiRouting.admission.reserveRun` (clarify lane, Sol r3 F1): one run's path
 * admitted as several allocations in ONE mutation. Each allocation is checked
 * against its own plane's capacity and the shared ceiling, the earlier
 * allocations of the same call included; any refusal admits nothing.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../_generated/api';
import { newHarness } from '../../__tests__/testModules';
import { reconcileSpend } from './spend.testlib';

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

function allocation(id: string, plane: 'language' | 'decision', heldMicrousd: number) {
	return {
		reservationId: id,
		rootRequestId: `postbox:${id}`,
		plane,
		task: plane === 'language' ? ('mail.extract' as const) : ('mail.claim_check' as const),
		budgetClass: 'standard' as const,
		priority: 'pipeline' as const,
		heldMicrousd,
		maxRequests: 1,
		requestBound: { microusd: heldMicrousd },
		expiresAt: Date.now() + 60_000,
	};
}

const holds = (t: ReturnType<typeof newHarness>) =>
	t.run((ctx) => ctx.db.query('llmReservations').collect());

describe('aiRouting.admission.reserveRun', () => {
	it('holds both allocations, each on its own plane', async () => {
		const t = await ready('10');
		const result = await t.mutation(internal.aiRouting.admission.reserveRun, {
			allocations: [
				allocation('run-lang', 'language', USD),
				allocation('run-dec', 'decision', USD),
			],
		});
		expect(result).toEqual({ isAdmitted: true, heldReservationIds: ['run-lang', 'run-dec'] });
		expect((await holds(t)).map((row) => [row.reservationId, row.plane, row.task])).toEqual([
			['run-lang', 'language', 'mail.extract'],
			['run-dec', 'decision', 'mail.claim_check'],
		]);
	});

	it('refuses the whole run when the decision plane’s capacity is spent: nothing is held', async () => {
		// $10 a day: the decision plane may hold at most $2.
		const t = await ready('10');
		await t.mutation(
			internal.aiRouting.admission.reserve,
			allocation('other', 'decision', 1.5 * USD)
		);
		const result = await t.mutation(internal.aiRouting.admission.reserveRun, {
			allocations: [
				allocation('run-lang', 'language', USD),
				allocation('run-dec', 'decision', USD),
			],
		});
		expect(result).toEqual({
			isAdmitted: false,
			reason: 'daily_ceiling',
			limit: 'plane_capacity',
		});
		// The language allocation, admitted first in the same call, is gone too.
		expect((await holds(t)).map((row) => row.reservationId)).toEqual(['other']);
	});

	it('serializes concurrent runs: the second cannot take decision capacity the first holds', async () => {
		const t = await ready('10');
		const results = await Promise.all(
			['a', 'b'].map((run) =>
				t.mutation(internal.aiRouting.admission.reserveRun, {
					allocations: [
						allocation(`${run}-lang`, 'language', USD),
						allocation(`${run}-dec`, 'decision', 1.5 * USD),
					],
				})
			)
		);
		expect(results.filter((r) => r.isAdmitted)).toHaveLength(1);
		expect(results.find((r) => !r.isAdmitted)).toMatchObject({ limit: 'plane_capacity' });
		const held = await holds(t);
		expect(held.filter((row) => row.plane === 'decision')).toHaveLength(1);
		expect(held.filter((row) => row.plane === 'language')).toHaveLength(1);
	});

	it('is idempotent by the allocations’ ids', async () => {
		const t = await ready('10');
		const args = {
			allocations: [
				allocation('run-lang', 'language', USD),
				allocation('run-dec', 'decision', USD),
			],
		};
		await t.mutation(internal.aiRouting.admission.reserveRun, args);
		expect(await t.mutation(internal.aiRouting.admission.reserveRun, args)).toEqual({
			isAdmitted: true,
			heldReservationIds: ['run-lang', 'run-dec'],
		});
		expect(await holds(t)).toHaveLength(2);
	});

	it('holds nothing without a ceiling', async () => {
		const t = newHarness();
		const result = await t.mutation(internal.aiRouting.admission.reserveRun, {
			allocations: [
				allocation('run-lang', 'language', USD),
				allocation('run-dec', 'decision', USD),
			],
		});
		expect(result).toEqual({ isAdmitted: true, heldReservationIds: [] });
		expect(await holds(t)).toEqual([]);
	});
});
