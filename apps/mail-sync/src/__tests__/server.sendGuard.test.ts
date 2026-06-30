import { describe, it, expect } from 'vitest';
import { isAllowedEmlUrl } from '../server.js';

const allowed = ['http://convex:3210', 'https://convex.example.com'];

describe('isAllowedEmlUrl (SSRF guard)', () => {
	it('accepts a storage URL on the internal convex origin', () => {
		expect(isAllowedEmlUrl('http://convex:3210/api/storage/abc', allowed)).toBe(true);
	});

	it('accepts the extra configured public origin', () => {
		expect(isAllowedEmlUrl('https://convex.example.com/api/storage/abc', allowed)).toBe(true);
	});

	it.each([
		'http://169.254.169.254/latest/meta-data/',
		'http://redis:6379/',
		'https://attacker.example/x.eml',
		'file:///etc/passwd',
		'gopher://convex:3210/x',
		'not a url',
		'http://convex:3210@attacker.example/',
	])('rejects %s', (url) => {
		expect(isAllowedEmlUrl(url, allowed)).toBe(false);
	});
});
