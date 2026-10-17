/**
 * A fixed panel anchored to an element: below when it fits, flipped above when
 * it does not and there is more room there, capped with internal scroll when it
 * fits on neither side, laid over the anchor as a last resort, and kept inside
 * the window sideways.
 */
import { describe, expect, it } from 'vitest';
import { placeAnchoredPanel } from '../anchoredPanelPlacement';

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
});
