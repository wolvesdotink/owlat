import { describe, it, expect } from 'vitest';
import {
	clampComposerSize,
	COMPOSER_SHEET_QUERY,
	layoutComposerStack,
	popupComposerGeometry,
	SMALL_SCREEN_MAX_POPUPS,
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
});

describe('popupComposerGeometry', () => {
	const size = { width: 380, height: 440 };

	it('keeps the persisted box anchored bottom right on a wide screen', () => {
		expect(popupComposerGeometry({ size, slotIndex: 0, sheet: false, keyboardInset: 0 })).toEqual({
			mode: 'box',
			style: {
				width: '380px',
				height: '440px',
				right: '24px',
				bottom: 'var(--pbx-composer-inset-bottom, 0px)',
			},
		});
		// The second popup steps left by a box and a gap.
		expect(
			popupComposerGeometry({ size, slotIndex: 1, sheet: false, keyboardInset: 0 }).style['right']
		).toBe('420px');
	});

	it('spans the width of a phone as a bottom sheet, whatever size was persisted', () => {
		const geometry = popupComposerGeometry({ size, slotIndex: 0, sheet: true, keyboardInset: 0 });
		expect(geometry.mode).toBe('sheet');
		expect(geometry.style).toMatchObject({ left: '0px', right: '0px', bottom: '0px' });
		expect(geometry.style['width']).toBeUndefined();
		expect(geometry.style['height']).toContain('100dvh');
		expect(geometry.style['height']).toContain('safe-area-inset-top');
		// Clear of the home indicator.
		expect(geometry.style['paddingBottom']).toBe('env(safe-area-inset-bottom, 0px)');
	});

	it('stands the sheet on the keyboard so Send stays above it', () => {
		const geometry = popupComposerGeometry({
			size,
			slotIndex: 0,
			sheet: true,
			keyboardInset: 336.4,
		});
		expect(geometry.style['bottom']).toBe('336px');
		expect(geometry.style['height']).toContain('- 336px)');
		expect(geometry.style['paddingBottom']).toBe('0px');
	});

	it('switches below Tailwind sm, where one composer floats at a time', () => {
		expect(COMPOSER_SHEET_QUERY).toBe('(max-width: 639.98px)');
		const layout = layoutComposerStack(
			[
				{ id: 'a', minimized: false },
				{ id: 'b', minimized: false },
			],
			SMALL_SCREEN_MAX_POPUPS
		);
		expect(layout.popups).toEqual([{ id: 'b', slot: 0 }]);
		expect(layout.dock).toEqual([{ id: 'a' }]);
	});
});
