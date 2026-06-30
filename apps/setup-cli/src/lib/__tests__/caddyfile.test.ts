import { describe, it, expect } from 'vitest';
import { buildCaddyfile } from '../caddyfile';

describe('buildCaddyfile', () => {
	const cf = buildCaddyfile({
		webHost: 'owlat.example.com',
		convexHost: 'convex.example.com',
		convexSiteHost: 'convex-site.example.com',
		email: 'admin@example.com',
	});

	it('sets the Let’s Encrypt account email', () => {
		expect(cf).toContain('email admin@example.com');
	});

	it('proxies the web host to web:3000', () => {
		expect(cf).toContain('owlat.example.com {');
		expect(cf).toContain('reverse_proxy web:3000');
	});

	it('proxies the convex host to convex:3210 with long websocket timeouts', () => {
		expect(cf).toContain('convex.example.com {');
		expect(cf).toContain('reverse_proxy convex:3210');
		expect(cf).toContain('reverse_proxy /api/* convex:3210');
		expect(cf).toContain('read_timeout 600s');
	});

	it('proxies the convex-site host to convex:3211', () => {
		expect(cf).toContain('convex-site.example.com {');
		expect(cf).toContain('reverse_proxy convex:3211');
	});

	it('sets HSTS security headers', () => {
		expect(cf).toContain('Strict-Transport-Security');
	});
});
