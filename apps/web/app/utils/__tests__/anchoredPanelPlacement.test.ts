/**
 * A fixed panel anchored to an element: below when it fits, flipped above when
 * it does not and there is more room there, capped with internal scroll when it
 * fits on neither side, laid over the anchor as a last resort, and kept inside
 * the window sideways.
 */
import { describe, expect, it } from 'vitest';
import { isAnchorInView, placeAnchoredPanel } from '../anchoredPanelPlacement';

const viewport = { width: 1440, height: 900 };
const rowAt = (top: number, left = 600) => ({ top, bottom: top + 40, left });

describe('placeAnchoredPanel', () => {
	it('opens under the anchor when the panel fits there', () => {
		const placed = placeAnchoredPanel({
			anchor: rowAt(200),
			panelHeight: 320,
			panelWidth: 352,
			viewport,
		});
		expect(placed.side).toBe('below');
		expect(placed.style).toEqual({ top: '246px', left: '600px', maxHeight: '646px' });
	});

	it('flips above a lower row on a 900 px window', () => {
		const placed = placeAnchoredPanel({
			anchor: rowAt(670),
			panelHeight: 320,
			panelWidth: 352,
			viewport,
		});
		expect(placed.side).toBe('above');
		expect(placed.style).toEqual({ bottom: '236px', left: '600px', maxHeight: '656px' });
		expect(placed.style.top).toBeUndefined();
	});

	it('caps the panel to the larger side, scrolling inside, when it fits on neither', () => {
		const placed = placeAnchoredPanel({
			anchor: rowAt(300),
			panelHeight: 700,
			panelWidth: 352,
			viewport: { width: 1440, height: 640 },
		});
		expect(placed.side).toBe('below');
		expect(placed.style.maxHeight).toBe('286px');
	});

	it('stays below when below is short but above is even shorter', () => {
		const placed = placeAnchoredPanel({
			anchor: rowAt(250),
			panelHeight: 700,
			panelWidth: 352,
			viewport: { width: 1440, height: 800 },
		});
		expect(placed.side).toBe('below');
		expect(placed.style.maxHeight).toBe('496px');
	});

	it('lays the panel over the anchor when both sides are slivers', () => {
		const placed = placeAnchoredPanel({
			anchor: { top: 90, bottom: 210, left: 0 },
			panelHeight: 400,
			panelWidth: 352,
			viewport: { width: 400, height: 300 },
		});
		expect(placed.side).toBe('overlay');
		expect(placed.style).toEqual({ top: '8px', left: '8px', maxHeight: '284px' });
	});

	it('keeps the panel inside the window on the right', () => {
		const placed = placeAnchoredPanel({
			anchor: rowAt(200, 1300),
			panelHeight: 200,
			panelWidth: 352,
			viewport,
		});
		expect(placed.style.left).toBe(`${1440 - 352 - 8}px`);
	});

	it('places below before the panel has a height', () => {
		const placed = placeAnchoredPanel({
			anchor: rowAt(820),
			panelHeight: 0,
			panelWidth: 352,
			viewport,
		});
		expect(placed.side).toBe('below');
	});

	it('keeps every bound inside a 600 px window when the anchor sits below it', () => {
		// Sol r1 F1: anchor.top 820 used to give bottom: -214px.
		const placed = placeAnchoredPanel({
			anchor: rowAt(820),
			panelHeight: 320,
			panelWidth: 352,
			viewport: { width: 1440, height: 600 },
		});
		expect(placed.side).toBe('above');
		expect(placed.style.bottom).toBe('8px');
		expect(placed.style.maxHeight).toBe('584px');
	});

	it('keeps the panel inside the window when the anchor scrolled off the top', () => {
		const placed = placeAnchoredPanel({
			anchor: { top: -120, bottom: -80, left: 600 },
			panelHeight: 320,
			panelWidth: 352,
			viewport: { width: 1440, height: 600 },
		});
		expect(placed.side).toBe('below');
		expect(placed.style.top).toBe('8px');
		expect(placed.style.maxHeight).toBe('584px');
	});

	it('never returns a bound outside the window, wherever the anchor is', () => {
		const margin = 8;
		for (const height of [300, 600, 900]) {
			for (let top = -400; top <= height + 400; top += 37) {
				for (const panelHeight of [0, 120, 320, 700]) {
					const { style } = placeAnchoredPanel({
						anchor: { top, bottom: top + 40, left: 600 },
						panelHeight,
						panelWidth: 352,
						viewport: { width: 1440, height },
					});
					const maxHeight = Number.parseFloat(style.maxHeight);
					const panelTop =
						style.top !== undefined
							? Number.parseFloat(style.top)
							: height - Number.parseFloat(style.bottom!) - Math.min(panelHeight, maxHeight);
					const panelBottom = panelTop + Math.min(panelHeight, maxHeight);
					expect(panelTop).toBeGreaterThanOrEqual(margin);
					expect(panelBottom).toBeLessThanOrEqual(height - margin);
				}
			}
		}
	});
});

describe('isAnchorInView', () => {
	const viewport = { width: 1440, height: 600 };
	it('is true while any of the anchor is inside the window', () => {
		expect(isAnchorInView({ top: 580, bottom: 620, left: 10, right: 50 }, viewport)).toBe(true);
		expect(isAnchorInView({ top: -20, bottom: 10, left: 10, right: 50 }, viewport)).toBe(true);
	});

	it('is false once the anchor has left the window on any side', () => {
		expect(isAnchorInView({ top: 820, bottom: 860, left: 10, right: 50 }, viewport)).toBe(false);
		expect(isAnchorInView({ top: -60, bottom: -20, left: 10, right: 50 }, viewport)).toBe(false);
		expect(isAnchorInView({ top: 100, bottom: 140, left: 1500, right: 1540 }, viewport)).toBe(
			false
		);
		expect(isAnchorInView({ top: 100, bottom: 140, left: -80, right: -40 }, viewport)).toBe(false);
	});
});
