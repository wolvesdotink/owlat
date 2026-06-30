import { describe, it, expect } from 'vitest';
import { safeRedirect } from '../safeRedirect';

const FALLBACK = '/dashboard';

describe('safeRedirect', () => {
	describe('accepts safe relative paths', () => {
		it.each([
			['/dashboard'],
			['/'],
			['/inbox'],
			['/inbox?folder=archived'],
			['/inbox?folder=archived&page=2'],
			['/settings#profile'],
			['/team/abc-123/members'],
		])('keeps %s', (value) => {
			expect(safeRedirect(value, FALLBACK)).toBe(value);
		});
	});

	describe('rejects absolute / scheme URLs', () => {
		it.each([
			['https://evil.com'],
			['http://evil.com/login'],
			['ftp://evil.com'],
			['javascript:alert(1)'],
			['JaVaScRiPt:alert(1)'],
			['data:text/html,<script>alert(1)</script>'],
			['vbscript:msgbox(1)'],
		])('rejects %s', (value) => {
			expect(safeRedirect(value, FALLBACK)).toBe(FALLBACK);
		});
	});

	describe('rejects protocol-relative & backslash tricks', () => {
		it.each([
			['//evil.com'],
			['///evil.com'],
			['/\\evil.com'],
			['/\\\\evil.com'],
		])('rejects %s', (value) => {
			expect(safeRedirect(value, FALLBACK)).toBe(FALLBACK);
		});
	});

	describe('rejects whitespace / control chars (smuggling)', () => {
		it.each([
			[' /dashboard'],
			['\t/dashboard'],
			['\n//evil.com'],
			['\r/dashboard'],
			['/dashboard\x00'],
		])('rejects %j', (value) => {
			expect(safeRedirect(value, FALLBACK)).toBe(FALLBACK);
		});
	});

	describe('rejects scheme-like substrings before query/hash', () => {
		// Even if the first char is "/", a colon in the path itself is suspicious.
		// Real Nuxt paths never use a literal colon outside of params.
		it.each([
			['/javascript:alert(1)'],
			['/foo:bar/baz'],
		])('rejects %s', (value) => {
			expect(safeRedirect(value, FALLBACK)).toBe(FALLBACK);
		});

		it('allows colon inside query string', () => {
			expect(safeRedirect('/inbox?ts=2026:05:15', FALLBACK)).toBe('/inbox?ts=2026:05:15');
		});

		it('allows colon inside hash', () => {
			expect(safeRedirect('/settings#section:profile', FALLBACK)).toBe('/settings#section:profile');
		});
	});

	describe('falls back on empty / non-string', () => {
		it.each([
			[undefined],
			[null],
			[''],
			[42],
			[{}],
			[[]],
		] as Array<[unknown]>)('falls back for %j', (value) => {
			expect(safeRedirect(value, FALLBACK)).toBe(FALLBACK);
		});
	});
});
