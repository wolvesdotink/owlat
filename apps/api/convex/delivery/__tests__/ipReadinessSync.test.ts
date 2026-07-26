import { describe, expect, it } from 'vitest';
import { normalizeIpReputationPayload } from '@owlat/shared/ipReadinessSync';

const legacyIp = {
	ip: '203.0.113.10',
	sent: 10,
	bounced: 1,
	deferred: 2,
	warmingPhase: 'ramp',
	warmingDay: 3,
	pool: 'campaign',
	active: true,
};

describe('normalizeIpReputationPayload', () => {
	it('keeps syncing a rolling-upgrade payload with no Phase-1 fields', () => {
		const result = normalizeIpReputationPayload({ date: '2026-07-21', ips: [legacyIp] });
		expect(result).toMatchObject({ phase: 'ramp', ipCount: 1, totalSentToday: 10 });
		expect(result?.ips[0]).not.toHaveProperty('fcrdns');
		expect(result?.ips[0]).not.toHaveProperty('dnsbl');
	});

	it('normalizes the nested runtime checklist into Convex-compatible optional fields', () => {
		const result = normalizeIpReputationPayload({
			date: '2026-07-21',
			ips: [
				{
					...legacyIp,
					active: false,
					blockReasons: ['fcrdns'],
					dnsbl: 'clean',
					dnsblCheckedAt: 122,
					fcrdns: {
						ehlo: 'mail.example.com',
						ptrNames: ['provider.invalid'],
						checklist: {
							ptrExists: true,
							ptrIsFqdn: true,
							forwardConfirmed: true,
							ehloMatches: false,
						},
						verdict: 'fail',
						genericPtr: false,
						reason: 'ehlo-mismatch',
						checkedAt: 123,
						overridden: false,
					},
				},
			],
		});
		expect(result?.ips[0]).toMatchObject({
			active: false,
			blockReasons: ['fcrdns'],
			dnsbl: 'clean',
			dnsblCheckedAt: 122,
			fcrdns: { verdict: 'fail', isEhloMatched: false, reason: 'ehlo-mismatch' },
		});
	});

	it('rejects malformed DNSBL timestamps while accepting finite IPv4 and IPv6 timestamps', () => {
		for (const ip of ['203.0.113.10', '2001:db8::10']) {
			expect(
				normalizeIpReputationPayload({
					date: '2026-07-21',
					ips: [{ ...legacyIp, ip, dnsbl: 'clean', dnsblCheckedAt: 456 }],
				})?.ips[0]
			).toMatchObject({ ip, dnsblCheckedAt: 456 });
		}
		expect(
			normalizeIpReputationPayload({
				date: '2026-07-21',
				ips: [{ ...legacyIp, dnsbl: 'clean', dnsblCheckedAt: Number.NaN }],
			})
		).toBeNull();
	});

	it('normalizes IPv6 prerequisite blocks and the return-path SPF verdict', () => {
		const result = normalizeIpReputationPayload({
			date: '2026-07-21',
			ips: [
				{
					...legacyIp,
					ip: '2001:db8::10',
					active: false,
					blockReasons: ['ipv4-identity', 'spf'],
					ipv6Spf: {
						domain: 'bounces.example.com',
						verdict: 'fail',
						reason: 'missing-ip6-mechanism',
						checkedAt: 456,
					},
				},
			],
		});

		expect(result?.ips[0]).toMatchObject({
			blockReasons: ['ipv4-identity', 'spf'],
			ipv6Spf: {
				domain: 'bounces.example.com',
				verdict: 'fail',
				reason: 'missing-ip6-mechanism',
				checkedAt: 456,
			},
		});
	});

	it('rejects a malformed top-level payload without mutating existing state', () => {
		expect(normalizeIpReputationPayload({ ips: 'not-an-array' })).toBeNull();
	});

	it('rejects the entire payload when one nested readiness row is malformed', () => {
		expect(
			normalizeIpReputationPayload({
				date: '2026-07-21',
				ips: [legacyIp, { ...legacyIp, ip: '203.0.113.11', fcrdns: { verdict: 'pass' } }],
			})
		).toBeNull();
	});

	it.each([
		['verdict', { fcrdns: { verdict: 'healthy' } }],
		['reason', { fcrdns: { verdict: 'fail', reason: 'dns-ish' } }],
		['DNSBL status', { dnsbl: 'ready' }],
		['block reason', { blockReasons: ['reputation-ish'] }],
		[
			'IPv6 SPF reason',
			{
				ipv6Spf: {
					domain: 'bounces.example.com',
					verdict: 'fail',
					reason: 'spf-ish',
					checkedAt: 123,
				},
			},
		],
	])('rejects an unknown %s instead of presenting it as ready', (_name, fields) => {
		expect(
			normalizeIpReputationPayload({
				date: '2026-07-21',
				ips: [{ ...legacyIp, ...fields }],
			})
		).toBeNull();
	});
});
