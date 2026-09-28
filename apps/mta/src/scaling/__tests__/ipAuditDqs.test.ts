import { beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis-mock';
import type RealRedis from 'ioredis';
import { auditZonesFor, runIpAuditSweep, type IpAuditDeps } from '../ipAudit.js';
import { storeSpamhausDqsKey } from '../../intelligence/dnsblAccess.js';

vi.mock('../../monitoring/logger.js', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const IP = '203.0.113.10';
const KEY = 'abcdefghijklmnopqrstuvwxyz';
const KEYED_ZONE = `${KEY}.zen.dq.spamhaus.net`;

function nxdomain(): Error {
	return Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
}

describe('auditZonesFor', () => {
	it('moves Spamhaus to the keyed zone only when a verified key is supplied', () => {
		const spamhaus = (config: { spamhausDqsKey?: string }) =>
			auditZonesFor({ abusixDnsblApiKey: undefined, ...config }, 'ipv4').find(
				(zone) => zone.zoneId === 'spamhaus'
			)?.zone;
		expect(spamhaus({})).toBe('zen.spamhaus.org');
		expect(spamhaus({ spamhausDqsKey: KEY })).toBe(KEYED_ZONE);
	});
});

describe('runIpAuditSweep with blocklist access', () => {
	let redis: RealRedis;
	let queried: string[];
	let fcrdnsQueried: string[];

	function deps(dnsbl: (hostname: string) => Promise<string[]>): IpAuditDeps {
		return {
			now: () => 1_000,
			dns: {
				resolve4: async (hostname) => {
					fcrdnsQueried.push(hostname);
					if (hostname === 'mail.example.com') return [IP];
					throw nxdomain();
				},
				dnsbl: async (hostname) => {
					queried.push(hostname);
					return dnsbl(hostname);
				},
				reverse: async () => ['mail.example.com'],
				resolve6: async () => [],
			},
			port25: async (ip) => ({
				ip,
				status: 'open',
				reason: 'connected',
				checkedAt: 1,
				targets: [],
			}),
			neighbourSampleSize: 1,
			zoneTimeoutMs: 50,
		};
	}
	const config = {
		ipPools: { transactional: [IP], campaign: [] },
		ehloHostname: 'mail.example.com',
		ehloHostnames: {},
	};

	beforeEach(async () => {
		redis = new Redis() as unknown as RealRedis;
		await redis.flushall();
		queried = [];
		fcrdnsQueried = [];
	});

	it('sends blocklist queries through the blocklist transport and the keyed zone', async () => {
		await storeSpamhausDqsKey(redis, KEY);
		const [record] = await runIpAuditSweep(
			redis,
			config,
			deps(async (hostname) => {
				if (hostname === `2.0.0.127.${KEYED_ZONE}`) return ['127.0.0.2'];
				throw nxdomain();
			})
		);

		expect(queried).toContain(`10.113.0.203.${KEYED_ZONE}`);
		expect(queried).toContain(`1.113.0.203.${KEYED_ZONE}`);
		expect(queried.some((name) => name.endsWith('.zen.spamhaus.org'))).toBe(false);
		expect(fcrdnsQueried.some((name) => name.includes('spamhaus'))).toBe(false);
		expect(record?.zones.find((zone) => zone.zoneId === 'spamhaus')?.status).toBe('clean');
	});

	it('falls back to the public zone when the key fails its test', async () => {
		await storeSpamhausDqsKey(redis, KEY);
		const [record] = await runIpAuditSweep(
			redis,
			config,
			deps(async (hostname) => {
				if (hostname.endsWith('.zen.spamhaus.org')) return ['127.255.255.254'];
				throw nxdomain();
			})
		);

		expect(queried).toContain('10.113.0.203.zen.spamhaus.org');
		expect(record?.zones.find((zone) => zone.zoneId === 'spamhaus')?.status).toBe('unknown');
	});
});
