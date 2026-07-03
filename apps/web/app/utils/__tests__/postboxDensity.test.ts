/**
 * Postbox density util (utils/postboxDensity):
 *   - default + normalisation of stored/unknown values, and
 *   - the contain-intrinsic-size height per density (must track the real
 *     compact vs comfortable row height so scroll estimation stays correct).
 */
import { describe, it, expect } from 'vitest';
import {
	POSTBOX_DENSITY_DEFAULT,
	POSTBOX_DENSITY_OPTIONS,
	POSTBOX_ROW_INTRINSIC_PX,
	postboxRowIntrinsicPx,
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

describe('postboxRowIntrinsicPx', () => {
	it('follows density: compact rows are materially shorter than comfortable', () => {
		expect(postboxRowIntrinsicPx('comfortable')).toBe(
			POSTBOX_ROW_INTRINSIC_PX.comfortable
		);
		expect(postboxRowIntrinsicPx('compact')).toBe(POSTBOX_ROW_INTRINSIC_PX.compact);
		expect(postboxRowIntrinsicPx('compact')).toBeLessThan(
			postboxRowIntrinsicPx('comfortable')
		);
	});
});
