import { describe, it, expect } from 'vitest';
import { parseVersion, semverCompare } from '../semver';

/**
 * One comparison for three callers (the server update check, the desktop update
 * resolver, the admin system page). The pre-release cases are the ones the
 * page's old private copy got wrong: it ignored suffixes entirely, so an rc
 * build compared equal to its release and looked current.
 */

describe('semverCompare', () => {
	it('orders by major, then minor, then patch', () => {
		expect(semverCompare('1.2.4', '1.2.3')).toBe(1);
		expect(semverCompare('1.2.3', '1.2.4')).toBe(-1);
		expect(semverCompare('1.2.3', '1.2.3')).toBe(0);
		expect(semverCompare('2.0.0', '1.99.99')).toBe(1);
		// Numeric, not lexicographic.
		expect(semverCompare('0.10.0', '0.9.0')).toBe(1);
	});

	it('sorts a pre-release below its release', () => {
		expect(semverCompare('1.2.0-beta.1', '1.2.0')).toBe(-1);
		expect(semverCompare('1.2.0', '1.2.0-beta.1')).toBe(1);
		expect(semverCompare('1.2.0-rc.2', '1.2.0-rc.1')).toBe(1);
		expect(semverCompare('1.2.0-rc.1', '1.2.0-rc.1')).toBe(0);
	});

	it('tolerates a leading v and missing components', () => {
		expect(semverCompare('v1.2.3', '1.2.3')).toBe(0);
		expect(semverCompare('1.3', '1.2.9')).toBe(1);
		expect(semverCompare('dev', '0.0.0')).toBe(0);
	});
});

describe('parseVersion', () => {
	it('splits the numeric components from the pre-release suffix', () => {
		expect(parseVersion('v1.2.3-rc.1')).toEqual({ parts: [1, 2, 3], pre: 'rc.1' });
		expect(parseVersion('0.4.6')).toEqual({ parts: [0, 4, 6], pre: '' });
	});

	it('reads missing or non-numeric components as 0 rather than throwing', () => {
		expect(parseVersion('1')).toEqual({ parts: [1, 0, 0], pre: '' });
		expect(parseVersion('')).toEqual({ parts: [0, 0, 0], pre: '' });
		expect(parseVersion('dev')).toEqual({ parts: [0, 0, 0], pre: '' });
	});
});
