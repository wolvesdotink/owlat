import { describe, it, expect } from 'vitest';
import {
	getColumnWidthPercents,
	getColumnWidths,
	isValidColumnWidths,
	setColumnWidth,
} from '../columnWidths';

describe('getColumnWidths', () => {
	it('single column is always full width', () => {
		expect(getColumnWidths(1, 'equal')).toEqual(['100%']);
		expect(getColumnWidths(1, 'left-wide')).toEqual(['100%']);
	});

	it('two-column ratios', () => {
		expect(getColumnWidths(2, 'equal')).toEqual(['50%', '50%']);
		expect(getColumnWidths(2, 'left-wide')).toEqual(['67%', '33%']);
		expect(getColumnWidths(2, 'right-wide')).toEqual(['33%', '67%']);
		expect(getColumnWidths(2, 'left-narrow')).toEqual(['33%', '67%']);
		expect(getColumnWidths(2, 'right-narrow')).toEqual(['67%', '33%']);
		expect(getColumnWidths(2, 'unknown')).toEqual(['50%', '50%']);
	});

	it('three-column ratios', () => {
		expect(getColumnWidths(3, 'equal')).toEqual(['33.33%', '33.33%', '33.33%']);
		expect(getColumnWidths(3, 'left-wide')).toEqual(['50%', '25%', '25%']);
		expect(getColumnWidths(3, 'right-wide')).toEqual(['25%', '25%', '50%']);
		expect(getColumnWidths(3, 'left-narrow')).toEqual(['25%', '37.5%', '37.5%']);
		expect(getColumnWidths(3, 'right-narrow')).toEqual(['37.5%', '37.5%', '25%']);
		expect(getColumnWidths(3, 'unknown')).toEqual(['33.33%', '33.33%', '33.33%']);
	});

	it('four-column ratios — including the narrow presets the editor copy used to drop', () => {
		expect(getColumnWidths(4, 'equal')).toEqual(['25%', '25%', '25%', '25%']);
		expect(getColumnWidths(4, 'left-wide')).toEqual(['40%', '20%', '20%', '20%']);
		expect(getColumnWidths(4, 'right-wide')).toEqual(['20%', '20%', '20%', '40%']);
		// Regression: these two used to fall through to equal widths in the
		// editor half, so the preview disagreed with the rendered email.
		expect(getColumnWidths(4, 'left-narrow')).toEqual(['15%', '28.33%', '28.33%', '28.33%']);
		expect(getColumnWidths(4, 'right-narrow')).toEqual(['28.33%', '28.33%', '28.33%', '15%']);
		expect(getColumnWidths(4, 'unknown')).toEqual(['25%', '25%', '25%', '25%']);
	});
});

describe('five columns', () => {
	it('has a preset for every ratio', () => {
		expect(getColumnWidths(5, 'equal')).toEqual(['20%', '20%', '20%', '20%', '20%']);
		expect(getColumnWidths(5, 'left-wide')).toEqual(['40%', '15%', '15%', '15%', '15%']);
		expect(getColumnWidths(5, 'right-wide')).toEqual(['15%', '15%', '15%', '15%', '40%']);
		expect(getColumnWidths(5, 'left-narrow')).toEqual(['12%', '22%', '22%', '22%', '22%']);
		expect(getColumnWidths(5, 'right-narrow')).toEqual(['22%', '22%', '22%', '22%', '12%']);
		expect(getColumnWidths(5, 'unknown')).toEqual(['20%', '20%', '20%', '20%', '20%']);
	});
});

describe('isValidColumnWidths', () => {
	it('accepts whole percentages that fill the row', () => {
		expect(isValidColumnWidths([15, 85], 2)).toBe(true);
		expect(isValidColumnWidths([40, 60], 2)).toBe(true);
		expect(isValidColumnWidths([20, 20, 20, 20, 20], 5)).toBe(true);
		expect(isValidColumnWidths([10, 90], 2)).toBe(true);
		expect(isValidColumnWidths([100], 1)).toBe(true);
	});

	it('rejects a length that does not match the column count', () => {
		expect(isValidColumnWidths([50, 50], 3)).toBe(false);
		expect(isValidColumnWidths([25, 25, 25, 25], 2)).toBe(false);
	});

	it('rejects a sum other than 100, fractions included', () => {
		expect(isValidColumnWidths([40, 50], 2)).toBe(false);
		expect(isValidColumnWidths([60, 60], 2)).toBe(false);
		expect(isValidColumnWidths([33.33, 33.33, 33.34], 3)).toBe(false);
	});

	it('rejects a column below the minimum', () => {
		expect(isValidColumnWidths([9, 91], 2)).toBe(false);
		expect(isValidColumnWidths([0, 100], 2)).toBe(false);
		expect(isValidColumnWidths([-10, 110], 2)).toBe(false);
	});

	it('rejects values that are not numbers', () => {
		expect(isValidColumnWidths(['40', '60'], 2)).toBe(false);
		expect(isValidColumnWidths([40, Number.NaN], 2)).toBe(false);
		expect(isValidColumnWidths('40,60', 2)).toBe(false);
		expect(isValidColumnWidths(undefined, 2)).toBe(false);
		expect(isValidColumnWidths([20, 20, 20, 20, 20, 0], 6)).toBe(false);
	});
});

describe('getColumnWidths with custom widths', () => {
	it('custom widths win over the ratio', () => {
		expect(getColumnWidths(2, 'equal', [15, 85])).toEqual(['15%', '85%']);
		expect(getColumnWidths(2, 'left-wide', [40, 60])).toEqual(['40%', '60%']);
	});

	it('falls back to the preset when the custom widths are invalid', () => {
		expect(getColumnWidths(2, 'left-wide', [40, 50])).toEqual(['67%', '33%']);
		expect(getColumnWidths(3, 'equal', [40, 60])).toEqual(['33.33%', '33.33%', '33.33%']);
		expect(getColumnWidths(1, 'equal', [100])).toEqual(['100%']);
	});
});

describe('getColumnWidthPercents', () => {
	it('rounds preset fractions to whole percents that sum to 100', () => {
		expect(getColumnWidthPercents(3, 'equal')).toEqual([34, 33, 33]);
		expect(getColumnWidthPercents(4, 'left-narrow')).toEqual([15, 29, 28, 28]);
		expect(getColumnWidthPercents(3, 'left-narrow')).toEqual([25, 38, 37]);
		expect(getColumnWidthPercents(2, 'left-wide')).toEqual([67, 33]);
		expect(getColumnWidthPercents(5, 'equal')).toEqual([20, 20, 20, 20, 20]);
	});

	it('returns valid custom widths unchanged', () => {
		expect(getColumnWidthPercents(2, 'equal', [15, 85])).toEqual([15, 85]);
	});
});

describe('setColumnWidth', () => {
	it('takes the difference from the next column', () => {
		expect(setColumnWidth([50, 50], 0, 15)).toEqual([15, 85]);
		expect(setColumnWidth([20, 20, 20, 20, 20], 1, 30)).toEqual([20, 30, 10, 20, 20]);
	});

	it('gives the difference to the previous column when the last one changes', () => {
		expect(setColumnWidth([50, 50], 1, 60)).toEqual([40, 60]);
		expect(setColumnWidth([25, 25, 25, 25], 3, 10)).toEqual([25, 25, 40, 10]);
	});

	it('takes from columns further along once the neighbour is at the minimum', () => {
		expect(setColumnWidth([20, 20, 20, 20, 20], 0, 50)).toEqual([50, 10, 10, 10, 20]);
		expect(setColumnWidth([20, 20, 20, 20, 20], 4, 50)).toEqual([20, 10, 10, 10, 50]);
	});

	it('clamps to the minimum and to what the other columns leave', () => {
		expect(setColumnWidth([50, 50], 0, 3)).toEqual([10, 90]);
		expect(setColumnWidth([50, 50], 0, 99)).toEqual([90, 10]);
		expect(setColumnWidth([20, 20, 20, 20, 20], 2, 100)).toEqual([10, 10, 60, 10, 10]);
	});

	it('rounds to whole percents and keeps the sum at 100', () => {
		const next = setColumnWidth([34, 33, 33], 0, 40.6);
		expect(next).toEqual([41, 26, 33]);
		expect(isValidColumnWidths(next, 3)).toBe(true);
	});

	it('ignores a value that is not a number', () => {
		expect(setColumnWidth([40, 60], 0, Number.NaN)).toEqual([40, 60]);
	});
});
