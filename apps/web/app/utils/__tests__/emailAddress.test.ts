import { describe, it, expect } from 'vitest';
import { extractEmailAddress } from '../emailAddress';

describe('extractEmailAddress', () => {
	it('extracts the address from "Name <addr>" framing, lowercased', () => {
		expect(extractEmailAddress('Ada Lovelace <Ada@Example.COM>')).toBe('ada@example.com');
	});

	it('returns a bare address trimmed + lowercased', () => {
		expect(extractEmailAddress('  Bob@Example.com ')).toBe('bob@example.com');
	});

	it('handles the first angle-bracket group only', () => {
		expect(extractEmailAddress('x <a@b.com> <c@d.com>')).toBe('a@b.com');
	});
});
