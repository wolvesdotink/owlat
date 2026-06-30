import { describe, it, expect } from 'vitest';
import { scanHomoglyphs, deconfuse } from '../content/homoglyphs.js';

describe('homoglyph detection', () => {
	describe('scanHomoglyphs', () => {
		it('returns empty for normal ASCII URLs', () => {
			const flags = scanHomoglyphs([
				{ href: 'https://google.com', text: 'Google' },
				{ href: 'https://example.com', text: 'Click here' },
			]);

			expect(flags).toHaveLength(0);
		});

		it('detects Cyrillic characters in domain', () => {
			// "gооgle.com" with Cyrillic о (U+043E) instead of Latin o
			const domain = 'g\u043E\u043Egle.com';
			const flags = scanHomoglyphs([
				{ href: `https://${domain}/search`, text: 'Search' },
			]);

			expect(flags.length).toBeGreaterThan(0);
			expect(flags[0]!.type).toBe('homoglyph_spoofing');
			expect(flags[0]!.severity).toBe('high');
		});

		it('detects Cyrillic "а" (U+0430) in domain mimicking Latin "a"', () => {
			// "pаypal.com" with Cyrillic а
			const domain = 'p\u0430ypal.com';
			const flags = scanHomoglyphs([
				{ href: `https://${domain}/login`, text: 'Login' },
			]);

			expect(flags.length).toBeGreaterThan(0);
			expect(flags[0]!.type).toBe('homoglyph_spoofing');
		});

		it('detects Cyrillic "с" (U+0441) mimicking Latin "c"', () => {
			const domain = 'fa\u0441ebook.com';
			const flags = scanHomoglyphs([
				{ href: `https://${domain}`, text: 'Facebook' },
			]);

			expect(flags.length).toBeGreaterThan(0);
		});

		it('detects confusable characters in link text that looks like a domain', () => {
			// Link text "pаypal.com" with Cyrillic а, linking to evil site
			const text = 'p\u0430ypal.com';
			const flags = scanHomoglyphs([
				{ href: 'https://evil-site.example.com', text },
			]);

			expect(flags.some(f =>
				f.type === 'homoglyph_spoofing' &&
				f.description.toLowerCase().includes('link text') // Should mention it's the link text
			)).toBe(true);
		});

		it('ignores link text without dots (non-domain-like)', () => {
			// Cyrillic in non-domain text should be ignored
			const text = 'Привет мир'; // "Hello world" in Russian
			const flags = scanHomoglyphs([
				{ href: 'https://example.com', text },
			]);

			// Should not flag — text doesn't look like a domain
			expect(flags).toHaveLength(0);
		});

		it('detects Greek characters used for spoofing', () => {
			// "Αpple.com" with Greek Alpha (Α, U+0391) instead of Latin A
			const domain = '\u0391pple.com';
			const flags = scanHomoglyphs([
				{ href: `https://${domain}`, text: 'Apple' },
			]);

			expect(flags.length).toBeGreaterThan(0);
			expect(flags[0]!.type).toBe('homoglyph_spoofing');
		});

		it('handles malformed URLs gracefully', () => {
			const flags = scanHomoglyphs([
				{ href: 'not-a-url', text: 'Click' },
				{ href: '', text: 'Empty' },
			]);

			// Should not throw, just skip
			expect(flags).toHaveLength(0);
		});

		it('detects mixed Cyrillic + Latin in domain', () => {
			// "miсrosoft.com" with Cyrillic с (U+0441)
			const domain = 'mi\u0441rosoft.com';
			const flags = scanHomoglyphs([
				{ href: `https://${domain}`, text: 'Microsoft' },
			]);

			expect(flags.length).toBeGreaterThan(0);
		});
	});

	describe('deconfuse', () => {
		it('converts Cyrillic lookalikes to Latin', () => {
			// "gооgle" with Cyrillic о → "google"
			const input = 'g\u043E\u043Egle';
			expect(deconfuse(input)).toBe('google');
		});

		it('preserves pure Latin text', () => {
			expect(deconfuse('hello world')).toBe('hello world');
		});

		it('converts mixed Cyrillic/Latin', () => {
			// "pаypаl" with Cyrillic а (U+0430) → "paypal"
			const input = 'p\u0430yp\u0430l';
			expect(deconfuse(input)).toBe('paypal');
		});

		it('converts Greek lookalikes', () => {
			// "Αpple" with Greek Alpha → "Apple"
			const input = '\u0391pple';
			expect(deconfuse(input)).toBe('Apple');
		});
	});
});
