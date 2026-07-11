import { describe, expect, it } from 'vitest';
import { buildInternalTokenUrl } from '../internalTokenUrl';

describe('buildInternalTokenUrl', () => {
	it('builds the endpoint from the configured origin', () => {
		// The builder only ever sees trusted config — it takes no Host parameter,
		// so a spoofed request Host header cannot influence the resulting origin.
		expect(buildInternalTokenUrl('https://acme.owlat.app')).toBe(
			'https://acme.owlat.app/api/auth/convex/token'
		);
	});

	it('normalises a trailing slash on the origin', () => {
		expect(buildInternalTokenUrl('https://acme.owlat.app/')).toBe(
			'https://acme.owlat.app/api/auth/convex/token'
		);
	});

	it('preserves a non-standard port', () => {
		expect(buildInternalTokenUrl('http://localhost:3000')).toBe(
			'http://localhost:3000/api/auth/convex/token'
		);
	});

	it('ignores any path on the configured origin (always uses the fixed endpoint)', () => {
		expect(buildInternalTokenUrl('https://acme.owlat.app/some/base')).toBe(
			'https://acme.owlat.app/api/auth/convex/token'
		);
	});

	it('throws on a malformed origin rather than emitting a relative URL', () => {
		expect(() => buildInternalTokenUrl('not a url')).toThrow();
	});
});
