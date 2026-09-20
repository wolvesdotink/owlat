/**
 * `owlat-setup sample-data` — argument parsing and count formatting. The
 * wiring guard (quickstart must never write OWLAT_DEV_MODE=true) lives in
 * scripts/check-installer-invariants.sh.
 */

import { describe, it, expect } from 'vitest';
import { parseAction, formatCounts } from '../sampleData.js';

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

describe('formatCounts', () => {
	// picocolors wraps the numbers when the environment forces color (CI does),
	// so assertions compare the text content, not the escape codes around it.
	const stripAnsi = (s: string) => s.replace(/\u001b\[\d+m/g, '');

	it('lists non-zero counts and drops the zeros', () => {
		const out = stripAnsi(formatCounts({ contacts: 15, topics: 3, webhooks: 0 }));
		expect(out).toContain('15 contacts');
		expect(out).toContain('3 topics');
		expect(out).not.toContain('webhooks');
	});

	it('says "none" for an empty result instead of an empty line', () => {
		expect(formatCounts({})).toContain('none');
		expect(formatCounts({ contacts: 0 })).toContain('none');
	});
});
