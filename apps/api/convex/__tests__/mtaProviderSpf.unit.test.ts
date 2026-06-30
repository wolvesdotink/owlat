/**
 * Unit tests for the SPF DNS records the MTA sending-domain provider generates
 * in `registerDomain` (PR-68). The MTA identity manager (DKIM HTTP call) is
 * mocked, so this exercises the pure DNS-bundle assembly without network I/O.
 *
 * Covers:
 *  - SPF_QUALIFIER='-all' with MTA_SPF_INCLUDE ⇒ apex SPF value ends ' -all'.
 *  - Default (no SPF_QUALIFIER) ⇒ soft-fail '~all'.
 *  - A bounce-domain (return-path) SPF entry exists when MTA_RETURN_PATH_DOMAIN
 *    + MTA_IP_POOLS are set, authorizing each pool IP.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../lib/emailProviders/mtaIdentity', () => ({
	createMtaIdentityManager: () => ({
		registerDomain: vi.fn().mockResolvedValue({
			selector: 's1',
			dnsRecord: 'v=DKIM1; k=rsa; p=MIGfMA0',
		}),
		deleteDomain: vi.fn().mockResolvedValue(undefined),
	}),
}));

import { mtaProvider } from '../domains/providers/mta';

const SPF_ENV_KEYS = ['MTA_SPF_INCLUDE', 'SPF_QUALIFIER', 'MTA_RETURN_PATH_DOMAIN', 'MTA_IP_POOLS'] as const;

describe('mtaProvider.registerDomain — SPF records', () => {
	let saved: Record<string, string | undefined>;

	beforeEach(() => {
		saved = {};
		for (const key of SPF_ENV_KEYS) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const key of SPF_ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	});

	it("emits ' -all' on the apex SPF when MTA_SPF_INCLUDE + SPF_QUALIFIER='-all'", async () => {
		process.env['MTA_SPF_INCLUDE'] = '_spf.owlat.example';
		process.env['SPF_QUALIFIER'] = '-all';

		const { dnsRecords } = await mtaProvider.registerDomain('acme.com');

		expect(dnsRecords.spf).toBeDefined();
		expect(dnsRecords.spf!.value).toBe('v=spf1 include:_spf.owlat.example -all');
		expect(dnsRecords.spf!.value.endsWith(' -all')).toBe(true);
	});

	it('defaults the apex SPF to the soft-fail ~all when SPF_QUALIFIER is unset', async () => {
		process.env['MTA_SPF_INCLUDE'] = '_spf.owlat.example';

		const { dnsRecords } = await mtaProvider.registerDomain('acme.com');

		expect(dnsRecords.spf!.value).toBe('v=spf1 include:_spf.owlat.example ~all');
	});

	it('omits the apex SPF record when MTA_SPF_INCLUDE is unset', async () => {
		const { dnsRecords } = await mtaProvider.registerDomain('acme.com');
		expect(dnsRecords.spf).toBeUndefined();
	});

	it('generates a return-path (bounce-domain) SPF entry when MTA_RETURN_PATH_DOMAIN + MTA_IP_POOLS are set', async () => {
		process.env['MTA_RETURN_PATH_DOMAIN'] = 'bounces.owlat.com';
		process.env['MTA_IP_POOLS'] = '203.0.113.10, 203.0.113.11';
		process.env['SPF_QUALIFIER'] = '-all';

		const { dnsRecords } = await mtaProvider.registerDomain('acme.com');

		expect(dnsRecords.mailFrom).toBeDefined();
		const bounceSpf = dnsRecords.mailFrom!.find((r) => r.value.startsWith('v=spf1'));
		expect(bounceSpf).toBeDefined();
		expect(bounceSpf!.hostname).toBe('bounces.owlat.com');
		expect(bounceSpf!.value).toBe('v=spf1 ip4:203.0.113.10 ip4:203.0.113.11 -all');
	});

	it('omits the return-path SPF entry when MTA_RETURN_PATH_DOMAIN is unset', async () => {
		const { dnsRecords } = await mtaProvider.registerDomain('acme.com');
		expect(dnsRecords.mailFrom).toBeUndefined();
	});

	it('omits the return-path SPF entry when MTA_IP_POOLS is empty', async () => {
		process.env['MTA_RETURN_PATH_DOMAIN'] = 'bounces.owlat.com';
		process.env['MTA_IP_POOLS'] = '  ,  ';

		const { dnsRecords } = await mtaProvider.registerDomain('acme.com');
		expect(dnsRecords.mailFrom).toBeUndefined();
	});
});
