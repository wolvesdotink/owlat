import { describe, it, expect } from 'vitest';
import {
	selectPreviousComparable,
	compareRates,
	type ComparableCampaign,
} from '~/utils/campaignReport';

function campaign(
	overrides: Partial<ComparableCampaign> & Pick<ComparableCampaign, 'id' | 'sentAt'>
): ComparableCampaign {
	return {
		name: overrides.name ?? overrides.id,
		isABTest: false,
		sent: 0,
		delivered: 0,
		opened: 0,
		clicked: 0,
		bounced: 0,
		...overrides,
	};
}

describe('selectPreviousComparable', () => {
	const current = { id: 'cur', sentAt: 1_000, isABTest: false };

	it('picks the most recent earlier send of the same kind', () => {
		const candidates = [
			campaign({ id: 'a', sentAt: 400 }),
			campaign({ id: 'b', sentAt: 900 }),
			campaign({ id: 'c', sentAt: 700 }),
		];
		expect(selectPreviousComparable(candidates, current)?.id).toBe('b');
	});

	it('excludes the current campaign itself', () => {
		const candidates = [campaign({ id: 'cur', sentAt: 1_000 }), campaign({ id: 'a', sentAt: 500 })];
		expect(selectPreviousComparable(candidates, current)?.id).toBe('a');
	});

	it('ignores sends at or after the current send', () => {
		const candidates = [
			campaign({ id: 'later', sentAt: 1_500 }),
			campaign({ id: 'same', sentAt: 1_000 }),
		];
		expect(selectPreviousComparable(candidates, current)).toBeNull();
	});

	it('only compares within the same kind (A/B vs regular)', () => {
		const abCurrent = { id: 'cur', sentAt: 1_000, isABTest: true };
		const candidates = [
			campaign({ id: 'regular', sentAt: 900, isABTest: false }),
			campaign({ id: 'ab', sentAt: 500, isABTest: true }),
		];
		expect(selectPreviousComparable(candidates, abCurrent)?.id).toBe('ab');
		// A regular current send must not match the earlier A/B send.
		expect(
			selectPreviousComparable([campaign({ id: 'ab', sentAt: 500, isABTest: true })], current)
		).toBeNull();
	});

	it('returns null when there are no candidates', () => {
		expect(selectPreviousComparable([], current)).toBeNull();
	});
});

describe('compareRates', () => {
	it('gives the rates without a change when there is no previous campaign', () => {
		const current = { sent: 100, delivered: 80, opened: 40, clicked: 8, bounced: 20 };
		expect(compareRates(current, null)).toEqual([
			{ key: 'openRate', rate: 0.5, pointsChange: null, direction: 'flat' },
			{ key: 'clickRate', rate: 0.1, pointsChange: null, direction: 'flat' },
		]);
	});

	it('reports an open-rate improvement in points, as up', () => {
		// prev open rate 33.5% (335/1000), current 38.4% (384/1000) → +4.9 pts.
		const [open] = compareRates(
			{ sent: 1000, delivered: 1000, opened: 384, clicked: 0, bounced: 0 },
			{ sent: 1000, delivered: 1000, opened: 335, clicked: 0, bounced: 0 }
		);
		expect(open).toMatchObject({ key: 'openRate', pointsChange: 4.9, direction: 'up' });
	});

	it('flags a click-rate regression as down', () => {
		const [, click] = compareRates(
			{ sent: 100, delivered: 100, opened: 0, clicked: 5, bounced: 0 },
			{ sent: 100, delivered: 100, opened: 0, clicked: 12, bounced: 0 }
		);
		expect(click).toMatchObject({ key: 'clickRate', pointsChange: -7, direction: 'down' });
	});

	it('reports no change as flat, never as a signed zero', () => {
		const snapshot = { sent: 100, delivered: 100, opened: 30, clicked: 5, bounced: 0 };
		for (const row of compareRates(snapshot, snapshot)) {
			expect(row.direction).toBe('flat');
			expect(Object.is(row.pointsChange, -0)).toBe(false);
			expect(row.pointsChange).toBe(0);
		}
	});

	it('handles a zero-denominator previous send without dividing by zero', () => {
		const [open] = compareRates(
			{ sent: 100, delivered: 80, opened: 40, clicked: 0, bounced: 0 },
			{ sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0 }
		);
		// prev open rate is 0 (no deliveries); current 50% → +50 pts, up.
		expect(open).toMatchObject({ pointsChange: 50, direction: 'up' });
	});

	it('only ever compares rates, never counts', () => {
		const rows = compareRates(
			{ sent: 100, delivered: 100, opened: 50, clicked: 10, bounced: 0 },
			{ sent: 10, delivered: 10, opened: 5, clicked: 1, bounced: 0 }
		);
		expect(rows.map((r) => r.key)).toEqual(['openRate', 'clickRate']);
		expect(rows.every((r) => r.pointsChange === 0)).toBe(true);
	});
});
