import { describe, it, expect } from 'vitest';
import { extractEmailAddress } from '../emailAddress';

describe('extractEmailAddress', () => {
	it('extracts the address from "Name <addr>" framing, lowercased', () => {
		expect(extractEmailAddress('Ada Lovelace <Ada@Example.COM>')).toBe('ada@example.com');
	});

	it('returns a bare address trimmed + lowercased', () => {
		expect(extractEmailAddress('  Bob@Example.com ')).toBe('bob@example.com');
	});

	it('skips an RFC 5322 comment that holds an address-shaped decoy', () => {
		// A local `<...>`/split regex read the comment; the shared parser does not.
		expect(extractEmailAddress('(x@a.com) real@evil.com')).toBe('real@evil.com');
	});

	it('keeps an "@" inside a quoted local part in the local part', () => {
		expect(extractEmailAddress('"a@b"@Evil.COM')).toBe('"a@b"@evil.com');
	});

	it('falls back to the trimmed, lowercased input when nothing parses', () => {
		expect(extractEmailAddress('  Undisclosed-Recipients ')).toBe('undisclosed-recipients');
		expect(extractEmailAddress('')).toBe('');
	});
});
