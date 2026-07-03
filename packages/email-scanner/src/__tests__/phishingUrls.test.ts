import { describe, it, expect } from 'vitest';
import { extractUrls, scanPhishingUrls } from '../content/phishingUrls.js';

describe('extractUrls', () => {
	it('extracts double-quoted hrefs', () => {
		const urls = extractUrls('<a href="https://example.com/a">A</a>');
		expect(urls).toEqual([{ href: 'https://example.com/a', text: 'A' }]);
	});

	it('extracts single-quoted hrefs', () => {
		const urls = extractUrls("<a href='https://example.com/b'>B</a>");
		expect(urls).toEqual([{ href: 'https://example.com/b', text: 'B' }]);
	});

	it('extracts unquoted hrefs (valid HTML5)', () => {
		const urls = extractUrls('<a href=http://evil.com/login>Click</a>');
		expect(urls).toEqual([{ href: 'http://evil.com/login', text: 'Click' }]);
	});

	it('extracts unquoted hrefs terminated by another attribute', () => {
		const urls = extractUrls('<a href=http://evil.com target=_blank>Click</a>');
		expect(urls[0]?.href).toBe('http://evil.com');
	});
});

describe('scanPhishingUrls', () => {
	it('flags a phishing pattern in an unquoted href', () => {
		const flags = scanPhishingUrls('<a href=https://paypa1.fake.xyz/login>verify</a>');
		expect(flags.some(f => f.type === 'phishing_url')).toBe(true);
	});

	it('flags a leading-space javascript: scheme', () => {
		const flags = scanPhishingUrls('<a href=" javascript:alert(1)">Click</a>');
		expect(
			flags.some(f => f.type === 'phishing_url' && f.severity === 'high'),
		).toBe(true);
	});

	it('still flags a plain javascript: scheme', () => {
		const flags = scanPhishingUrls('<a href="javascript:alert(1)">Click</a>');
		expect(
			flags.some(f => f.type === 'phishing_url' && f.severity === 'high'),
		).toBe(true);
	});
});
