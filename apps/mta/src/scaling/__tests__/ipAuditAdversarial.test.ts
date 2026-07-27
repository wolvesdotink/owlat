import { describe, expect, it, vi } from 'vitest';
import type Redis from 'ioredis';
import {
	auditIp,
	auditZonesFor,
	classifyNeighbourAnswer,
	getIpAuditRecord,
	ipAuditIsDue,
	neighbourAddresses,
	runIpAuditSweep,
	type IpAuditConfig,
	type IpAuditDeps,
	type IpAuditRecord,
} from '../ipAudit.js';
import type { Port25ProbeResult } from '../port25Probe.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const IP = '203.0.113.10';

function codedError(code: string): Error & { code: string } {
	const error = new Error(code) as Error & { code: string };
	error.code = code;
	return error;
}

function config(overrides: Partial<IpAuditConfig> = {}): IpAuditConfig {
	return {
		ipPools: { transactional: [IP], campaign: [] },
		ehloHostname: 'mail.example.com',
		ehloHostnames: {},
		...overrides,
	};
}

function openPort25(ip: string): Promise<Port25ProbeResult> {
	return Promise.resolve({
		ip,
		status: 'open',
		reason: 'connected',
		checkedAt: 1,
		targets: [],
	});
}

function deps(overrides: Partial<IpAuditDeps> = {}): IpAuditDeps {
	return {
		now: () => 1_700_000_000_000,
		dns: {
			// Everything NXDOMAINs (the clean DNSBL answer) except the forward
			// lookup that confirms our own PTR.
			resolve4: (hostname: string) =>
				hostname === 'mail.example.com'
					? Promise.resolve([IP])
					: Promise.reject(codedError('ENOTFOUND')),
			reverse: () => Promise.resolve(['mail.example.com']),
			resolve6: () => Promise.resolve([]),
		},
		port25: openPort25,
		zoneTimeoutMs: 50,
		...overrides,
	};
}

function fakeRedis(failSetFor: string[] = []): { redis: Redis; store: Map<string, string> } {
	const store = new Map<string, string>();
	const redis = {
		get: (key: string) => Promise.resolve(store.get(key) ?? null),
		set: (key: string, value: string) => {
			if (failSetFor.some((ip) => key.endsWith(ip))) {
				return Promise.reject(new Error('redis unavailable'));
			}
			store.set(key, value);
			return Promise.resolve('OK');
		},
	} as unknown as Redis;
	return { redis, store };
}

/**
 * With every resolver down, each zone we actually query must report `unknown`
 * — never `clean`. The credential-gated feeds carry no key in this fixture, so
 * they must stay `skipped`: a dead resolver may not turn an inert feed into a
 * signal (D2).
 */
function expectEveryReachableZoneUnknown(record: IpAuditRecord): void {
	const keyed = record.zones.filter((zone) => zone.status === 'skipped');
	expect(keyed.map((zone) => zone.zoneId).sort()).toEqual(['abusix', 'invaluement']);
	const queried = record.zones.filter((zone) => zone.status !== 'skipped');
	expect(queried.length).toBeGreaterThan(0);
	expect(queried.every((zone) => zone.status === 'unknown')).toBe(true);
}

describe('resolver failures are unknown, never clean', () => {
	it('treats SERVFAIL from every zone as an incomplete audit', async () => {
		const record = await auditIp(
			IP,
			config(),
			deps({
				dns: {
					resolve4: () => Promise.reject(codedError('ESERVFAIL')),
					reverse: () => Promise.resolve(['mail.example.com']),
				},
			})
		);
		expectEveryReachableZoneUnknown(record);
		expect(record.verdict).not.toBe('clean');
		expect(record.confidence).toBe('low');
		expect(record.findings.map((finding) => finding.id)).toContain('audit_incomplete');
	});

	it('treats a reverse-DNS resolver failure as unverified, not as a pass', async () => {
		const record = await auditIp(
			IP,
			config(),
			deps({
				dns: {
					resolve4: () => Promise.reject(codedError('ENOTFOUND')),
					reverse: () => Promise.reject(codedError('ESERVFAIL')),
				},
			})
		);
		expect(record.fcrdns.verdict).not.toBe('pass');
		expect(record.verdict).not.toBe('clean');
	});

	it('survives a reverse-DNS verifier that throws outright', async () => {
		const record = await auditIp(
			IP,
			config(),
			deps({
				dns: {
					resolve4: () => Promise.reject(codedError('ENOTFOUND')),
					reverse: () => {
						throw new Error('boom');
					},
				},
			})
		);
		expect(record.fcrdns.verdict).toBe('error');
		expect(record.verdict).not.toBe('clean');
	});
});

describe('hostile and degenerate DNS responses are bounded', () => {
	it('caps a huge RRset and a single oversized answer', async () => {
		const flood = Array.from({ length: 5_000 }, (_, index) => `127.0.0.${index % 255}`);
		flood.push('1'.repeat(5_000));
		const record = await auditIp(
			IP,
			config(),
			deps({
				dns: {
					resolve4: () => Promise.resolve(flood),
					reverse: () => Promise.resolve(['mail.example.com']),
				},
			})
		);
		for (const zone of record.zones) {
			expect(zone.answers.length).toBeLessThanOrEqual(16);
			for (const answer of zone.answers) expect(answer.length).toBeLessThanOrEqual(45);
		}
	});

	it('terminates when a resolver never answers', async () => {
		const record = await auditIp(
			IP,
			config(),
			deps({
				zoneTimeoutMs: 20,
				dns: {
					resolve4: () => new Promise<string[]>(() => undefined),
					reverse: () => Promise.resolve(['mail.example.com']),
				},
			})
		);
		expectEveryReachableZoneUnknown(record);
		expect(record.verdict).not.toBe('clean');
	});

	it('does not throw when the port-25 probe itself rejects', async () => {
		const record = await auditIp(
			IP,
			config(),
			deps({ port25: () => Promise.reject(new Error('probe exploded')) })
		);
		expect(record.port25).toBe('unknown');
		expect(record.confidence).toBe('low');
	});

	it('produces a report for an IPv6 address with no /24 to sample', async () => {
		const record = await auditIp(
			'2001:db8::25',
			config({ ipPools: { transactional: ['2001:db8::25'], campaign: [] } }),
			deps({ neighbourSampleSize: 16 })
		);
		expect(record.neighbourhoodStatus).toBe('insufficient_data');
		expect(record.neighbourhood).toEqual({ sampled: 0, listed: 0 });
		// An address with no /24 cannot be sampled at all, so the missing sample is
		// inert: it must not pin every IPv6 audit at low confidence forever.
		expect(record.confidence).toBe('high');
	});

	it('samples the /24 without ever probing the address itself', () => {
		const neighbours = neighbourAddresses('203.0.113.33', 16);
		expect(neighbours).not.toContain('203.0.113.33');
		expect(neighbours.every((ip) => ip.startsWith('203.0.113.'))).toBe(true);
		expect(neighbourAddresses('2001:db8::25', 16)).toEqual([]);
		expect(neighbourAddresses('not-an-ip', 16)).toEqual([]);
		expect(neighbourAddresses('203.0.113.33', 0)).toEqual([]);
	});
});

/**
 * The per-neighbour rule is the sole input to the only `unusable` verdict the
 * /24 sample can produce on its own, so every branch is pinned here.
 */
describe('classifyNeighbourAnswer', () => {
	it('does not count a neighbour that gave no definite answer', () => {
		expect(classifyNeighbourAnswer('unknown', [])).toBeNull();
		expect(classifyNeighbourAnswer('unknown', ['sbl'])).toBeNull();
	});

	it('counts a clean neighbour as clean', () => {
		expect(classifyNeighbourAnswer('clean', [])).toBe(false);
	});

	it('excludes a decoded PBL-only listing: it is a policy statement about the range', () => {
		expect(classifyNeighbourAnswer('listed', ['pbl'])).toBe(false);
	});

	it('counts any spam listing, including one alongside PBL', () => {
		expect(classifyNeighbourAnswer('listed', ['sbl'])).toBe(true);
		expect(classifyNeighbourAnswer('listed', ['pbl', 'css'])).toBe(true);
	});

	it('counts an undecodable listing: it is still a listing', () => {
		expect(classifyNeighbourAnswer('listed', [])).toBe(true);
	});

	it('drives the noisy-/24 verdict end to end', async () => {
		// Every neighbour answers CSS-listed; only the audited address is clean.
		const record = await auditIp(
			IP,
			config(),
			deps({
				neighbourSampleSize: 16,
				dns: {
					resolve4: (hostname: string) => {
						if (hostname === 'mail.example.com') return Promise.resolve([IP]);
						if (hostname.startsWith('10.113.0.203.'))
							return Promise.reject(codedError('ENOTFOUND'));
						return Promise.resolve(['127.0.0.3']);
					},
					reverse: () => Promise.resolve(['mail.example.com']),
				},
			})
		);
		expect(record.neighbourhoodStatus).toBe('noisy');
		expect(record.verdict).toBe('unusable');
	});
});

describe('missing third-party credentials are inert', () => {
	it('skips keyed feeds instead of failing or warning', async () => {
		const zones = auditZonesFor({}, 'ipv4');
		expect(zones.find((zone) => zone.zoneId === 'abusix')?.zone).toBeNull();
		expect(zones.find((zone) => zone.zoneId === 'invaluement')?.zone).toBeNull();

		const record = await auditIp(IP, config(), deps());
		const skipped = record.zones.filter((zone) => zone.status === 'skipped');
		expect(skipped.map((zone) => zone.zoneId).sort()).toEqual(['abusix', 'invaluement']);
		expect(record.verdict).toBe('clean');
		expect(record.confidence).toBe('high');
	});

	it('queries the keyed feeds once their credentials exist', () => {
		const zones = auditZonesFor(
			{
				abusixDnsblApiKey: 'abcdefghijklmnopqrstuvwxyz012345',
				invaluementDnsblZone: 'sip.example.invaluement.com',
			},
			'ipv4'
		);
		expect(zones.find((zone) => zone.zoneId === 'abusix')?.zone).toContain(
			'abcdefghijklmnopqrstuvwxyz012345.'
		);
		expect(zones.find((zone) => zone.zoneId === 'invaluement')?.zone).toBe(
			'sip.example.invaluement.com'
		);
	});
});

describe('the sweep is advisory and always terminates', () => {
	it('persists a record per configured address', async () => {
		const { redis, store } = fakeRedis();
		const records = await runIpAuditSweep(
			redis,
			config({ ipPools: { transactional: [IP], campaign: ['203.0.113.11'] } }),
			deps()
		);
		expect(records).toHaveLength(2);
		expect(store.size).toBe(2);
		expect((await getIpAuditRecord(redis, IP))?.ip).toBe(IP);
	});

	it('keeps going when one address fails to persist', async () => {
		const { redis, store } = fakeRedis([IP]);
		const records = await runIpAuditSweep(
			redis,
			config({ ipPools: { transactional: [IP], campaign: ['203.0.113.11'] } }),
			deps()
		);
		expect(records.map((record) => record.ip)).toEqual(['203.0.113.11']);
		expect(store.size).toBe(1);
	});

	it('returns no record rather than throwing on corrupt stored JSON', async () => {
		const { redis, store } = fakeRedis();
		store.set('mta:ip-audit:203.0.113.10', '{not json');
		expect(await getIpAuditRecord(redis, IP)).toBeNull();
	});

	it('returns no record for valid JSON of the wrong shape', async () => {
		const { redis, store } = fakeRedis();
		// Written by an older build: parses fine, then throws on the first
		// iteration of `findings`. It must read as ABSENT, not as a half-record.
		store.set('mta:ip-audit:203.0.113.10', JSON.stringify({ ip: IP, checkedAt: 1 }));
		expect(await getIpAuditRecord(redis, IP)).toBeNull();

		store.set(
			'mta:ip-audit:203.0.113.10',
			JSON.stringify({ ip: IP, checkedAt: '1', findings: [], zones: [] })
		);
		expect(await getIpAuditRecord(redis, IP)).toBeNull();

		store.set('mta:ip-audit:203.0.113.10', JSON.stringify([]));
		expect(await getIpAuditRecord(redis, IP)).toBeNull();

		store.set('mta:ip-audit:203.0.113.10', 'null');
		expect(await getIpAuditRecord(redis, IP)).toBeNull();
	});

	it('is due when nothing is stored and not due again within the day', async () => {
		const { redis } = fakeRedis();
		const now = 1_700_000_000_000;
		expect(await ipAuditIsDue(redis, config(), now)).toBe(true);
		await runIpAuditSweep(redis, config(), deps({ now: () => now }));
		expect(await ipAuditIsDue(redis, config(), now + 60_000)).toBe(false);
		expect(await ipAuditIsDue(redis, config(), now + 25 * 60 * 60 * 1000)).toBe(true);
	});
});
