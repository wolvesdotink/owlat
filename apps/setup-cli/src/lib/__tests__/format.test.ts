import { describe, it, expect } from 'vitest';
import { formatCounts } from '../format';
import { stripVTControlCharacters as stripAnsi } from 'node:util';

// picocolors wraps the numbers when the environment forces color (CI does),
// so assertions compare the text content, not the escape codes around it.

describe('formatCounts', () => {
	it('lists non-zero counts and drops the zeros', () => {
		const out = stripAnsi(formatCounts({ contacts: 15, topics: 3, webhooks: 0 }));
		expect(out).toBe('15 contacts, 3 topics');
	});

	it('says "none" for an empty result instead of an empty line', () => {
		expect(stripAnsi(formatCounts({}))).toBe('none');
		expect(stripAnsi(formatCounts({ contacts: 0 }))).toBe('none');
	});

	it('uses the caller empty text when one is given', () => {
		const empty = 'nothing (instance was already blank)';
		expect(stripAnsi(formatCounts({}, empty))).toBe(empty);
		expect(stripAnsi(formatCounts({ users: 2 }, empty))).toBe('2 users');
	});
});
