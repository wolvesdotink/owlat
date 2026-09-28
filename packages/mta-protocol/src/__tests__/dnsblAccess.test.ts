import { describe, expect, it } from 'vitest';
import { normalizeDnsblAccess } from '../dnsblAccess';

const ready = {
	resolver: { configured: 'bundled', lastPath: 'bundled' },
	spamhaus: {
		access: 'dqs',
		keyHint: 'wxyz',
		status: 'unknown',
		reason: 'key_rejected',
		checkedAt: 1_000,
	},
};

describe('normalizeDnsblAccess', () => {
	it('keeps a well-formed answer as it is', () => {
		expect(normalizeDnsblAccess(ready)).toEqual(ready);
	});

	it('rejects an answer without the shape the card needs', () => {
		expect(normalizeDnsblAccess(null)).toBeNull();
		expect(normalizeDnsblAccess({ ...ready, resolver: { configured: 'doh' } })).toBeNull();
		expect(
			normalizeDnsblAccess({ ...ready, spamhaus: { ...ready.spamhaus, status: 'maybe' } })
		).toBeNull();
		expect(
			normalizeDnsblAccess({ ...ready, spamhaus: { ...ready.spamhaus, access: 'paid' } })
		).toBeNull();
	});

	it('drops optional fields it cannot vouch for, and never passes more than a key hint', () => {
		const normalized = normalizeDnsblAccess({
			resolver: { configured: 'system', lastPath: 'elsewhere' },
			spamhaus: {
				access: 'dqs',
				keyHint: 'abcdefghijklmnopqrstuvwxyz',
				status: 'unknown',
				reason: 'resolver_policy',
				checkedAt: 'yesterday',
			},
		});
		expect(normalized).toEqual({
			resolver: { configured: 'system' },
			spamhaus: { access: 'dqs', status: 'unknown' },
		});
	});
});
