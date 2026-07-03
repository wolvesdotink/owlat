/**
 * Postbox density util (utils/postboxDensity): default + normalisation of
 * stored/unknown values. (The contain-intrinsic-size height per density is a
 * static CSS token in postbox-density.css, not a JS constant.)
 */
import { describe, it, expect } from 'vitest';
import {
	POSTBOX_DENSITY_DEFAULT,
	POSTBOX_DENSITY_OPTIONS,
	resolvePostboxDensity,
} from '../postboxDensity';

describe('resolvePostboxDensity', () => {
	it('defaults to comfortable', () => {
		expect(POSTBOX_DENSITY_DEFAULT).toBe('comfortable');
	});

	it('normalises an unset / unknown value to the default', () => {
		expect(resolvePostboxDensity(undefined)).toBe('comfortable');
		expect(resolvePostboxDensity(null)).toBe('comfortable');
		expect(resolvePostboxDensity('nonsense')).toBe('comfortable');
	});

	it('passes through the two known values', () => {
		expect(resolvePostboxDensity('comfortable')).toBe('comfortable');
		expect(resolvePostboxDensity('compact')).toBe('compact');
	});

	it('offers exactly the two modes as options', () => {
		expect(POSTBOX_DENSITY_OPTIONS.map((o) => o.value)).toEqual([
			'comfortable',
			'compact',
		]);
	});
});
