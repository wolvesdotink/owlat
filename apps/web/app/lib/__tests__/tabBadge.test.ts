import { describe, expect, it } from 'vitest';
import { badgedTitle } from '../tabBadge';

describe('badgedTitle', () => {
	it('prefixes the page title with the unread count', () => {
		expect(badgedTitle('Mail — Owlat', 3)).toBe('(3) Mail — Owlat');
	});

	it('keeps a localized title as the page wrote it', () => {
		expect(badgedTitle('Posteingang — Owlat', 12)).toBe('(12) Posteingang — Owlat');
	});

	it('falls back to the product name when the page has no title', () => {
		expect(badgedTitle(undefined, 3)).toBe('(3) Owlat');
		expect(badgedTitle(null, 3)).toBe('(3) Owlat');
		expect(badgedTitle('   ', 3)).toBe('(3) Owlat');
	});

	it('leaves the title alone at zero', () => {
		expect(badgedTitle('Mail — Owlat', 0)).toBe('Mail — Owlat');
		expect(badgedTitle('Mail — Owlat', -1)).toBe('Mail — Owlat');
	});

	it('shows a whole number', () => {
		expect(badgedTitle('Mail — Owlat', 2.7)).toBe('(2) Mail — Owlat');
	});
});
