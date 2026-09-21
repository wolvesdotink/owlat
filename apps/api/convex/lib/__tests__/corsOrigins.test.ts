import { describe, it, expect, afterEach, vi } from 'vitest';
import { corsHeaders, publicCorsHeaders } from '../cors';

/**
 * L10: the private CORS allow-list no longer silently falls back to
 * `http://localhost` in production. When ALLOWED_ORIGINS is unset it derives
 * from SITE_URL / ADMIN_SITE_URL and fails closed if neither is set; dev
 * (`OWLAT_DEV_MODE`) keeps the loopback default. Public CORS stays open.
 */

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('corsHeaders allow-list resolution', () => {
	it('uses the explicit ALLOWED_ORIGINS list when set', () => {
		vi.stubEnv('ALLOWED_ORIGINS', 'https://app.example.com, https://admin.example.com');
		const headers = corsHeaders('GET, POST', 'https://admin.example.com');
		expect(headers['Access-Control-Allow-Origin']).toBe('https://admin.example.com');

		const unknown = corsHeaders('GET, POST', 'https://evil.example.com');
		expect(unknown['Access-Control-Allow-Origin']).toBe('https://app.example.com');
	});

	it('keeps the loopback default in dev mode', () => {
		vi.stubEnv('OWLAT_DEV_MODE', 'true');
		vi.stubEnv('ALLOWED_ORIGINS', '');
		vi.stubEnv('SITE_URL', '');
		const headers = corsHeaders('GET', 'http://localhost:3000');
		expect(headers['Access-Control-Allow-Origin']).toBe('http://localhost:3000');
	});

	it('fails closed in production when nothing is configured', () => {
		vi.stubEnv('OWLAT_DEV_MODE', '');
		vi.stubEnv('ALLOWED_ORIGINS', '');
		vi.stubEnv('SITE_URL', '');
		vi.stubEnv('ADMIN_SITE_URL', '');
		expect(() => corsHeaders('GET', 'http://localhost:3000')).toThrow(/ALLOWED_ORIGINS|SITE_URL/);
	});

	it('derives from SITE_URL / ADMIN_SITE_URL in production when ALLOWED_ORIGINS is unset', () => {
		vi.stubEnv('OWLAT_DEV_MODE', '');
		vi.stubEnv('ALLOWED_ORIGINS', '');
		vi.stubEnv('SITE_URL', 'https://app.example.com');
		vi.stubEnv('ADMIN_SITE_URL', 'https://admin.example.com');
		expect(corsHeaders('GET', 'https://admin.example.com')['Access-Control-Allow-Origin']).toBe(
			'https://admin.example.com'
		);
		// An unlisted origin is pinned back to the first allowed origin.
		expect(corsHeaders('GET', 'http://localhost:3000')['Access-Control-Allow-Origin']).toBe(
			'https://app.example.com'
		);
	});
});

describe('publicCorsHeaders stays open', () => {
	it('always returns a wildcard origin', () => {
		expect(publicCorsHeaders()['Access-Control-Allow-Origin']).toBe('*');
	});
});
