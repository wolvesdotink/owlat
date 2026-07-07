import { describe, it, expect } from 'vitest';
import {
	clampComposerSize,
	layoutComposerStack,
	MIN_COMPOSER_WIDTH,
	MIN_COMPOSER_HEIGHT,
} from '../postboxComposerLayout';

describe('clampComposerSize', () => {
	const bigViewport = { width: 2000, height: 2000 };

	it('keeps an in-bounds size (rounded)', () => {
		expect(clampComposerSize({ width: 500, height: 600 }, bigViewport)).toEqual({
			width: 500,
			height: 600,
		});
	});

	it('clamps below the minimum up to the floor', () => {
		expect(clampComposerSize({ width: 100, height: 100 }, bigViewport)).toEqual({
			width: MIN_COMPOSER_WIDTH,
			height: MIN_COMPOSER_HEIGHT,
		});
	});

	it('clamps above the max fraction of the viewport (90vw / 85vh)', () => {
		const vp = { width: 1000, height: 1000 };
		const clamped = clampComposerSize({ width: 5000, height: 5000 }, vp);
		expect(clamped.width).toBe(900); // 90% of 1000
		expect(clamped.height).toBe(850); // 85% of 1000
	});

	it('never inverts the range on a tiny viewport (floor wins)', () => {
		const clamped = clampComposerSize({ width: 400, height: 400 }, { width: 200, height: 200 });
		expect(clamped.width).toBe(MIN_COMPOSER_WIDTH);
		expect(clamped.height).toBe(MIN_COMPOSER_HEIGHT);
	});

	it('falls back to the minimum on a non-finite stored value', () => {
		expect(clampComposerSize({ width: NaN, height: Infinity }, bigViewport)).toEqual({
			width: MIN_COMPOSER_WIDTH,
			height: MIN_COMPOSER_HEIGHT,
		});
	});
});

describe('layoutComposerStack', () => {
	const spec = (id: string, minimized = false) => ({ id, minimized });

	it('floats one or two composers with no dock', () => {
		const one = layoutComposerStack([spec('a')]);
		expect(one.popups).toEqual([{ id: 'a', slot: 0 }]);
		expect(one.dock).toEqual([]);

		const two = layoutComposerStack([spec('a'), spec('b')]);
		// Newest (b) is the rightmost slot 0; oldest (a) sits to its left.
		expect(two.popups).toEqual([
			{ id: 'a', slot: 1 },
			{ id: 'b', slot: 0 },
		]);
		expect(two.dock).toEqual([]);
	});

	it('docks the overflow once three are open (no offscreen march)', () => {
		const layout = layoutComposerStack([spec('a'), spec('b'), spec('c')]);
		// Only the two newest float; the oldest docks.
		expect(layout.popups).toEqual([
			{ id: 'b', slot: 1 },
			{ id: 'c', slot: 0 },
		]);
		expect(layout.dock).toEqual([{ id: 'a' }]);
	});

	it('docks every minimized composer and floats the expanded remainder', () => {
		const layout = layoutComposerStack([spec('a', true), spec('b'), spec('c', true)]);
		expect(layout.popups).toEqual([{ id: 'b', slot: 0 }]);
		expect(layout.dock).toEqual([{ id: 'a' }, { id: 'c' }]);
	});

	it('docks all when everything is minimized', () => {
		const layout = layoutComposerStack([spec('a', true), spec('b', true)]);
		expect(layout.popups).toEqual([]);
		expect(layout.dock).toEqual([{ id: 'a' }, { id: 'b' }]);
	});

	it('keeps the focused composer floating even when it falls out of the newest window', () => {
		// a is focused but oldest; opening b and c would normally dock a. The focus
		// surface teleports a into a popup, so a must stay floating (the oldest of
		// the two newest, b, drops to the dock instead) — never an empty mount.
		const layout = layoutComposerStack([spec('a'), spec('b'), spec('c')], undefined, 'a');
		expect(layout.popups.map((p) => p.id).sort()).toEqual(['a', 'c']);
		expect(layout.dock).toEqual([{ id: 'b' }]);
	});

	it('is a no-op when the focused composer is already floating', () => {
		const layout = layoutComposerStack([spec('a'), spec('b'), spec('c')], undefined, 'c');
		expect(layout.popups).toEqual([
			{ id: 'b', slot: 1 },
			{ id: 'c', slot: 0 },
		]);
		expect(layout.dock).toEqual([{ id: 'a' }]);
	});
});
