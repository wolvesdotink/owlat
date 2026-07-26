import { describe, expect, it } from 'vitest';
import type { MtaConfig } from '../../config.js';
import { dnsblCheckedAt } from '../ipReputation.js';

const config = { abusixDnsblApiKey: 'key' } as MtaConfig;

describe('IP reputation DNSBL observation timestamp', () => {
	it('uses the oldest applicable IPv4 list timestamp', () => {
		expect(
			dnsblCheckedAt(config, '203.0.113.10', {
				spamhausAt: '400',
				barracudaAt: '100',
				spamcopAt: '300',
				abusixAt: '200',
			})
		).toBe(100);
	});

	it('ignores IPv4-only lists for an IPv6 address', () => {
		expect(
			dnsblCheckedAt(config, '2001:db8::10', {
				spamhausAt: '400',
				abusixAt: '200',
			})
		).toBe(200);
	});

	it('returns no proof when any applicable timestamp is missing or malformed', () => {
		expect(dnsblCheckedAt(config, '203.0.113.10', { spamhausAt: '400' })).toBeUndefined();
		expect(
			dnsblCheckedAt(config, '2001:db8::10', {
				spamhausAt: '400',
				abusixAt: 'not-a-number',
			})
		).toBeUndefined();
	});
});
