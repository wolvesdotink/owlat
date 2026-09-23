import { describe, expect, it } from 'vitest';
import {
	DELIVERY_MIGRATE_ROUTE,
	hasNoIndependenceTraffic,
	hasNoMeasuredTraffic,
	isRampInactive,
} from '../deliveryAdvancedEmpty';

describe('isRampInactive', () => {
	it('is inactive with no cells, or when no cell is managed by the ramp', () => {
		expect(isRampInactive([])).toBe(true);
		expect(isRampInactive([{ isRampManaged: false }, { isRampManaged: false }])).toBe(true);
	});

	it('is active as soon as one cell is managed', () => {
		expect(isRampInactive([{ isRampManaged: false }, { isRampManaged: true }])).toBe(false);
	});
});

describe('hasNoMeasuredTraffic', () => {
	const cell = (own: number, reference: number | null) => ({
		own: { sent: own },
		reference: reference === null ? null : { sent: reference },
	});

	it('is quiet when nothing went out on either arm', () => {
		expect(hasNoMeasuredTraffic([])).toBe(true);
		expect(hasNoMeasuredTraffic([cell(0, null), cell(0, 0)])).toBe(true);
	});

	it('counts traffic on either arm', () => {
		expect(hasNoMeasuredTraffic([cell(0, null), cell(3, null)])).toBe(false);
		expect(hasNoMeasuredTraffic([cell(0, 12)])).toBe(false);
	});
});

describe('hasNoIndependenceTraffic', () => {
	it('is quiet for an empty or all-zero series', () => {
		expect(hasNoIndependenceTraffic([])).toBe(true);
		expect(hasNoIndependenceTraffic([{ day: 1, own: 0, reference: 0 }])).toBe(true);
	});

	it('ignores values that are not real counts', () => {
		expect(hasNoIndependenceTraffic([{ day: 1, own: Number.NaN, reference: -5 }])).toBe(true);
	});

	it('sees a single sent message on either arm', () => {
		expect(hasNoIndependenceTraffic([{ day: 1, own: 1, reference: 0 }])).toBe(false);
		expect(hasNoIndependenceTraffic([{ day: 1, own: 0, reference: 4 }])).toBe(false);
	});
});

it('points every empty state at the migration flow', () => {
	expect(DELIVERY_MIGRATE_ROUTE).toBe('/dashboard/admin/delivery/migrate');
});
