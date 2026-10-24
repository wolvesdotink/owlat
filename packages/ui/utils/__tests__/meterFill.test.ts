import { describe, expect, it } from 'vitest';
import { meterFillStyle } from '../meterFill';

const valueOf = (percent: number) => meterFillStyle(percent)['--ui-meter-value'];

describe('meterFillStyle', () => {
	it('passes a value inside the track through unchanged', () => {
		expect(valueOf(0)).toBe('0');
		expect(valueOf(42.5)).toBe('42.5');
		expect(valueOf(100)).toBe('100');
	});

	it('clamps to the track, so an over-budget value never slides past the end', () => {
		expect(valueOf(-12)).toBe('0');
		expect(valueOf(250)).toBe('100');
	});

	it('draws an empty fill for a ratio over an empty total', () => {
		expect(valueOf(0 / 0)).toBe('0');
		expect(valueOf(Infinity)).toBe('0');
	});

	it('sets only the custom property, never a layout property', () => {
		expect(Object.keys(meterFillStyle(30))).toEqual(['--ui-meter-value']);
	});
});
