import { describe, it, expect, afterEach } from 'vitest';
import { resolveLocalHost, resolveLocalUrls } from '../localHost';

describe('resolveLocalHost', () => {
	afterEach(() => {
		delete process.env['OWLAT_LOCAL_HOST'];
	});

	it('defaults to localhost (blessed Linux host-networking path)', () => {
		expect(resolveLocalHost({})).toBe('localhost');
	});

	it('honours OWLAT_LOCAL_HOST (Docker Desktop bridge path)', () => {
		expect(resolveLocalHost({ OWLAT_LOCAL_HOST: 'host.docker.internal' })).toBe(
			'host.docker.internal',
		);
	});

	it('reads process.env by default', () => {
		process.env['OWLAT_LOCAL_HOST'] = 'host.docker.internal';
		expect(resolveLocalHost()).toBe('host.docker.internal');
	});
});

describe('resolveLocalUrls', () => {
	it('local install with no host defaults to localhost ports', () => {
		expect(resolveLocalUrls({ network: false, env: {}, localHost: 'localhost' })).toEqual({
			localCloud: 'http://localhost:3210',
			localSite: 'http://localhost:3211',
		});
	});

	it('honours OWLAT_LOCAL_HOST for a local install (Docker Desktop)', () => {
		expect(
			resolveLocalUrls({ network: false, env: {}, localHost: 'host.docker.internal' }),
		).toEqual({
			localCloud: 'http://host.docker.internal:3210',
			localSite: 'http://host.docker.internal:3211',
		});
	});

	it('domain install ignores PUBLIC env URLs and addresses the local host ports', () => {
		expect(
			resolveLocalUrls({
				network: true,
				env: {
					NUXT_PUBLIC_CONVEX_URL: 'https://convex.example.com',
					CONVEX_SITE_URL: 'https://example.com',
				},
				localHost: 'host.docker.internal',
			}),
		).toEqual({
			localCloud: 'http://host.docker.internal:3210',
			localSite: 'http://host.docker.internal:3211',
		});
	});

	it('local install prefers .env values when present', () => {
		expect(
			resolveLocalUrls({
				network: false,
				env: {
					NUXT_PUBLIC_CONVEX_URL: 'http://127.0.0.1:3210',
					CONVEX_SITE_URL: 'http://127.0.0.1:3211',
				},
				localHost: 'host.docker.internal',
			}),
		).toEqual({
			localCloud: 'http://127.0.0.1:3210',
			localSite: 'http://127.0.0.1:3211',
		});
	});

	it('site falls back to NUXT_PUBLIC_CONVEX_SITE_URL then the local host', () => {
		expect(
			resolveLocalUrls({
				network: false,
				env: { NUXT_PUBLIC_CONVEX_SITE_URL: 'http://127.0.0.1:9999' },
				localHost: 'localhost',
			}),
		).toEqual({
			localCloud: 'http://localhost:3210',
			localSite: 'http://127.0.0.1:9999',
		});
	});

	it('defaults localHost from process.env when omitted', () => {
		delete process.env['OWLAT_LOCAL_HOST'];
		expect(resolveLocalUrls({ network: false, env: {} })).toEqual({
			localCloud: 'http://localhost:3210',
			localSite: 'http://localhost:3211',
		});
	});
});
