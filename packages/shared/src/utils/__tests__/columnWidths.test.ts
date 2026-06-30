import { describe, it, expect } from 'vitest';
import { getColumnWidths } from '../columnWidths';

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
