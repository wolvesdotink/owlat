import { describe, expect, it } from 'vitest';
import { normalizeIpReputationPayload } from '../ipReadinessSync';

const baseIp = {
	ip: '203.0.113.1',
	sent: 10,
	bounced: 0,
	deferred: 0,
	warmingPhase: 'ramp',
	warmingDay: 1,
	pool: 'campaign',
	active: true,
	dnsbl: 'degraded',
};

describe('IP readiness DNSBL detail', () => {
	it('carries only canonical list ids into the operator DTO', () => {
		expect(
			normalizeIpReputationPayload({
				date: '2026-07-21',
				ips: [{ ...baseIp, dnsblListings: ['barracuda', 'abusix'] }],
			})?.ips[0]
		).toMatchObject({ dnsbl: 'degraded', dnsblListings: ['barracuda', 'abusix'] });
	});

	it('rejects unknown provider names instead of generating an unsafe docs link', () => {
		expect(
			normalizeIpReputationPayload({
				date: '2026-07-21',
				ips: [{ ...baseIp, dnsblListings: ['mystery-list'] }],
			})
		).toBeNull();
	});
});
