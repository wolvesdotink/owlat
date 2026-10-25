import { describe, expect, it } from 'vitest';
import { placeTooltip } from '../tooltipPlacement';

const viewport = { width: 1000, height: 800 };
const anchor = (left: number, top: number, size = 32) => ({
	left,
	top,
	right: left + size,
	bottom: top + size,
});

describe('placeTooltip', () => {
	it('centres the bubble above the anchor', () => {
		expect(placeTooltip({ anchor: anchor(484, 400), width: 100, height: 24, viewport })).toEqual({
			side: 'top',
			top: 400 - 6 - 24,
			left: 450,
		});
	});

	it('flips below when there is no room above', () => {
		expect(placeTooltip({ anchor: anchor(484, 10), width: 100, height: 24, viewport })).toEqual({
			side: 'bottom',
			top: 10 + 32 + 6,
			left: 450,
		});
	});

	it('keeps the preferred side when the other one has even less room', () => {
		const short = { width: 1000, height: 60 };
		const placed = placeTooltip({
			anchor: anchor(484, 14, 32),
			width: 100,
			height: 40,
			viewport: short,
		});
		expect(placed.side).toBe('top');
		// Kept inside the window even though it overlaps the anchor.
		expect(placed.top).toBe(8);
	});

	it('honours a bottom preference and flips it up at the bottom edge', () => {
		expect(
			placeTooltip({ anchor: anchor(484, 400), width: 100, height: 24, viewport, side: 'bottom' })
				.side
		).toBe('bottom');
		expect(
			placeTooltip({ anchor: anchor(484, 760), width: 100, height: 24, viewport, side: 'bottom' })
		).toEqual({ side: 'top', top: 760 - 6 - 24, left: 450 });
	});

	it('clamps sideways inside the window margin', () => {
		expect(placeTooltip({ anchor: anchor(0, 400), width: 200, height: 24, viewport }).left).toBe(8);
		expect(
			placeTooltip({ anchor: anchor(980, 400, 20), width: 200, height: 24, viewport }).left
		).toBe(1000 - 200 - 8);
	});

	it('pins a bubble wider than the window to the left margin', () => {
		expect(placeTooltip({ anchor: anchor(100, 400), width: 2000, height: 24, viewport }).left).toBe(
			8
		);
	});

	it('rounds to whole pixels', () => {
		const placed = placeTooltip({
			anchor: { left: 100.3, right: 120.6, top: 300.4, bottom: 320.2 },
			width: 50.5,
			height: 20.5,
			viewport,
		});
		expect(Number.isInteger(placed.top)).toBe(true);
		expect(Number.isInteger(placed.left)).toBe(true);
	});
});
