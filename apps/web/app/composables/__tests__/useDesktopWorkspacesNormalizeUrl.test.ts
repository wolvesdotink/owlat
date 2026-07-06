import { describe, it, expect } from 'vitest';
import { normalizeSiteUrl } from '../useDesktopWorkspaces';

/**
 * Regression for the desktop "Connect to your Owlat server" dialog: schemeless
 * input was always prefixed with https:// — including for localhost, where the
 * dev server speaks plain http, so "localhost:3000" produced
 * https://localhost:3000 and the instance-info probe died with an opaque
 * "Load failed". Local hosts without an explicit scheme must default to http;
 * everything else stays https-forced.
 */
describe('normalizeSiteUrl', () => {
	it('defaults schemeless localhost input to http', () => {
		expect(normalizeSiteUrl('localhost:3000')).toBe('http://localhost:3000');
		expect(normalizeSiteUrl('127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
	});

	it('keeps an explicit scheme on localhost', () => {
		expect(normalizeSiteUrl('http://localhost:3000')).toBe('http://localhost:3000');
		expect(normalizeSiteUrl('https://localhost:3000')).toBe('https://localhost:3000');
	});

	it('forces https for non-local hosts', () => {
		expect(normalizeSiteUrl('acme.owlat.app')).toBe('https://acme.owlat.app');
		expect(normalizeSiteUrl('http://acme.owlat.app')).toBe('https://acme.owlat.app');
	});

	it('reduces to the origin and trims whitespace', () => {
		expect(normalizeSiteUrl('  https://acme.owlat.app/dashboard?x=1  ')).toBe(
			'https://acme.owlat.app'
		);
	});
});
