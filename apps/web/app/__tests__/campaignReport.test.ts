import { describe, it, expect } from 'vitest';
import {
	selectPreviousComparable,
	computeStatDeltas,
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

describe('computeStatDeltas', () => {
	it('returns empty deltas when there is no previous send', () => {
		const current = { sent: 100, delivered: 90, opened: 45, clicked: 9, bounced: 10 };
		const deltas = computeStatDeltas(current, null);
		expect(deltas.opened).toEqual({ text: null, direction: 'flat' });
		expect(deltas.bounced).toEqual({ text: null, direction: 'flat' });
	});

	it('reports an open-rate improvement as up', () => {
		// prev open rate 40% (40/100), current 50% (50/100) → +10 pts, up.
		const deltas = computeStatDeltas(
			{ sent: 100, delivered: 100, opened: 50, clicked: 0, bounced: 0 },
			{ sent: 100, delivered: 100, opened: 40, clicked: 0, bounced: 0 }
		);
		expect(deltas.opened).toEqual({ text: '10.0 pts', direction: 'up' });
	});

	it('treats fewer bounces as an improvement (up)', () => {
		// prev bounce rate 10%, current 4% → improvement, direction up.
		const deltas = computeStatDeltas(
			{ sent: 100, delivered: 96, opened: 0, clicked: 0, bounced: 4 },
			{ sent: 100, delivered: 90, opened: 0, clicked: 0, bounced: 10 }
		);
		expect(deltas.bounced).toEqual({ text: '6.0 pts', direction: 'up' });
	});

	it('flags a click-rate regression as down', () => {
		const deltas = computeStatDeltas(
			{ sent: 100, delivered: 100, opened: 0, clicked: 5, bounced: 0 },
			{ sent: 100, delivered: 100, opened: 0, clicked: 12, bounced: 0 }
		);
		expect(deltas.clicked).toEqual({ text: '7.0 pts', direction: 'down' });
	});

	it('reports a flat delta when rates are unchanged', () => {
		const snapshot = { sent: 100, delivered: 100, opened: 30, clicked: 5, bounced: 0 };
		const deltas = computeStatDeltas(snapshot, snapshot);
		expect(deltas.opened).toEqual({ text: '0.0 pts', direction: 'flat' });
	});

	it('handles a zero-denominator previous send without dividing by zero', () => {
		const deltas = computeStatDeltas(
			{ sent: 100, delivered: 80, opened: 40, clicked: 0, bounced: 0 },
			{ sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0 }
		);
		// prev open rate is 0 (no deliveries); current 50% → +50 pts, up.
		expect(deltas.opened).toEqual({ text: '50.0 pts', direction: 'up' });
	});
});
