/**
 * `owlat-setup sample-data` — argument parsing. Count formatting is covered in
 * lib/__tests__/format.test.ts; the wiring guard (quickstart must never write
 * OWLAT_DEV_MODE=true) lives in scripts/check-installer-invariants.sh.
 */

import { describe, it, expect } from 'vitest';
import { parseAction } from '../sampleData.js';

describe('parseAction', () => {
	it('accepts the three actions', () => {
		expect(parseAction(['install'])).toBe('install');
		expect(parseAction(['remove'])).toBe('remove');
		expect(parseAction(['status'])).toBe('status');
	});

	it('reports usage when no action is given', () => {
		expect(parseAction([])).toEqual({ error: expect.stringContaining('install|remove|status') });
	});

	it('names the unknown action rather than guessing one', () => {
		const result = parseAction(['nuke']);
		expect(result).toEqual({ error: expect.stringContaining("'nuke'") });
	});

	it('ignores trailing arguments', () => {
		expect(parseAction(['remove', 'extra'])).toBe('remove');
	});
});
