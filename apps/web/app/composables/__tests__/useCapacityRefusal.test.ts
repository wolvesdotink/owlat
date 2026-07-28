/**
 * The wiring between a refused send and the schedule panel.
 *
 * This is the seam `useCampaignActions` and the wizard's Review step both hand
 * to `useBackendOperation`'s `onError`, so it is where the two invariants live:
 * a capacity refusal is CLAIMED (returns `true`, so the module skips its red
 * toast and its telemetry report) and every other failure is NOT (returns
 * `false`, so shipped behaviour is untouched). Nothing else asserted that
 * before — the composable exists to make it assertable.
 */
import { describe, it, expect } from 'vitest';
import type { OperationError } from '@owlat/shared/operationError';

import { useCapacityRefusal } from '../useCapacityRefusal';

const PLAN = {
	fits: false,
	days: 4,
	slices: [0, 100, 200, 300],
	finishesAt: Date.UTC(2026, 0, 10),
	covered: 600,
	truncated: false,
	audienceUnderCounted: false,
};

function error(data: Record<string, unknown> | undefined): OperationError {
	return { category: 'invalid_state', message: 'nope', ...(data ? { data } : {}) };
}

describe('useCapacityRefusal', () => {
	it('starts with no schedule', () => {
		expect(useCapacityRefusal().capacitySchedule.value).toBeNull();
	});

	it('claims an exceeds_sending_capacity failure and holds its schedule', () => {
		const { capacitySchedule, claimCapacityRefusal } = useCapacityRefusal();

		const claimed = claimCapacityRefusal(
			error({ reason: 'exceeds_sending_capacity', capacityPlan: PLAN })
		);

		expect(claimed).toBe(true);
		expect(capacitySchedule.value).toEqual({
			days: 4,
			slices: [0, 100, 200, 300],
			finishesAt: Date.UTC(2026, 0, 10),
			covered: 600,
			truncated: false,
			audienceUnderCounted: false,
		});
	});

	const unclaimed: ReadonlyArray<[string, Record<string, unknown> | undefined]> = [
		['a different invalid_state reason', { reason: 'campaign_already_sent' }],
		['no reason at all', { field: 'name' }],
		['no data', undefined],
		[
			'a capacity refusal whose plan is unrenderable',
			{ reason: 'exceeds_sending_capacity', capacityPlan: { days: 0 } },
		],
	];

	it.each(unclaimed)('does not claim %s', (_label, data) => {
		const { capacitySchedule, claimCapacityRefusal } = useCapacityRefusal();

		expect(claimCapacityRefusal(error(data))).toBe(false);
		expect(capacitySchedule.value).toBeNull();
	});

	it('claims per-instance, so two surfaces never share a schedule', () => {
		const editor = useCapacityRefusal();
		const wizard = useCapacityRefusal();

		editor.claimCapacityRefusal(error({ reason: 'exceeds_sending_capacity', capacityPlan: PLAN }));

		expect(editor.capacitySchedule.value).not.toBeNull();
		expect(wizard.capacitySchedule.value).toBeNull();
	});

	it('clears the schedule on dismiss', () => {
		const { capacitySchedule, claimCapacityRefusal, dismissCapacitySchedule } =
			useCapacityRefusal();
		claimCapacityRefusal(error({ reason: 'exceeds_sending_capacity', capacityPlan: PLAN }));
		expect(capacitySchedule.value).not.toBeNull();

		dismissCapacitySchedule();

		expect(capacitySchedule.value).toBeNull();
	});
});
