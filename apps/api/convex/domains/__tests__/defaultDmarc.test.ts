/**
 * One default `_dmarc` record for every sending-domain provider adapter.
 *
 * The MTA, SES and Mandrill adapters all publish the record from
 * `defaultDmarcDnsRecord`, and `MTA_DMARC_RUA` is read only through
 * `dmarcRuaFromEnv`. These cases pin that the three adapters agree with and
 * without the env var set, and that the relay adapters' apex SPF strings (now
 * built through `buildSpfRecordValue`) are byte-identical to the literals they
 * replaced.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/emailProviders/mtaIdentity', () => ({
	createMtaIdentityManager: () => ({
		registerDomain: vi.fn().mockResolvedValue({ selector: 's1', dnsRecord: 'v=DKIM1; p=K' }),
		deleteDomain: vi.fn(),
	}),
}));

vi.mock('../../lib/emailProviders/sesIdentity', async (importActual) => {
	const actual = await importActual<Record<string, unknown>>();
	return {
		...actual,
		createSESIdentityManager: () => ({
			registerDomain: vi
				.fn()
				.mockResolvedValue({ verificationToken: 'tok', dkimTokens: ['a', 'b', 'c'] }),
			setupMailFromDomain: vi.fn().mockResolvedValue(undefined),
			getRegion: () => 'us-east-1',
			deleteIdentity: vi.fn(),
		}),
	};
});

import { defaultDmarcDnsRecord, dmarcRuaFromEnv } from '../dmarc';
import { buildMandrillDnsRecords } from '../providers/mandrill/records';
import { mtaProvider } from '../providers/mta/index';
import { sesProvider } from '../providers/ses/index';

const DOMAIN = 'acme.com';

async function dmarcFromEveryAdapter() {
	const mta = await mtaProvider.registerDomain(DOMAIN);
	const ses = await sesProvider.registerDomain(DOMAIN);
	const mandrill = buildMandrillDnsRecords(DOMAIN);
	return {
		mta: mta.dnsRecords.dmarc,
		ses: ses.dnsRecords.dmarc,
		mandrill: mandrill.dmarc,
	};
}

describe('default DMARC record across provider adapters', () => {
	beforeEach(() => {
		vi.stubEnv('MTA_DMARC_RUA', '');
		vi.stubEnv('MTA_SPF_INCLUDE', '');
		vi.stubEnv('MTA_RETURN_PATH_DOMAIN', '');
		vi.stubEnv('MTA_IP_POOLS', '');
		vi.stubEnv('MTA_TLSRPT_RUA', '');
		vi.stubEnv('SPF_QUALIFIER', '');
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('publishes the monitor-only record with no rua= when MTA_DMARC_RUA is unset', async () => {
		const expected = { type: 'TXT', host: '_dmarc', value: 'v=DMARC1; p=none' };
		const records = await dmarcFromEveryAdapter();

		expect(records.mta).toEqual(expected);
		expect(records.ses).toEqual(expected);
		expect(records.mandrill).toEqual(expected);
		expect(defaultDmarcDnsRecord(DOMAIN)).toEqual(expected);
	});

	it('carries the same trimmed rua= on every adapter when MTA_DMARC_RUA is set', async () => {
		vi.stubEnv('MTA_DMARC_RUA', '  mailto:dmarc-reports@owlat.com  ');
		const expected = {
			type: 'TXT',
			host: '_dmarc',
			value: 'v=DMARC1; p=none; rua=mailto:dmarc-reports@owlat.com',
		};
		const records = await dmarcFromEveryAdapter();

		expect(records.mta).toEqual(expected);
		expect(records.ses).toEqual(expected);
		expect(records.mandrill).toEqual(expected);
	});

	it('dmarcRuaFromEnv trims and maps blank to undefined', () => {
		expect(dmarcRuaFromEnv()).toBeUndefined();
		vi.stubEnv('MTA_DMARC_RUA', '   ');
		expect(dmarcRuaFromEnv()).toBeUndefined();
		vi.stubEnv('MTA_DMARC_RUA', ' mailto:a@owlat.com ');
		expect(dmarcRuaFromEnv()).toBe('mailto:a@owlat.com');
	});

	it("puts Owlat's own report address first once it can read reports", () => {
		vi.stubEnv('MTA_RETURN_PATH_DOMAIN', 'bounces.owlat.com');
		// No webhook secret: the forward could never be accepted, so no address.
		vi.stubEnv('MTA_WEBHOOK_SECRET', '');
		expect(dmarcRuaFromEnv()).toBeUndefined();
		vi.stubEnv('MTA_WEBHOOK_SECRET', 'secret');
		expect(dmarcRuaFromEnv()).toBe('mailto:dmarc-reports@bounces.owlat.com');
		vi.stubEnv('MTA_DMARC_RUA', 'mailto:a@elsewhere.example');
		expect(dmarcRuaFromEnv()).toBe(
			'mailto:dmarc-reports@bounces.owlat.com,mailto:a@elsewhere.example'
		);
		vi.stubEnv('MTA_DMARC_RUA', 'mailto:dmarc-reports@bounces.owlat.com');
		expect(dmarcRuaFromEnv()).toBe('mailto:dmarc-reports@bounces.owlat.com');
		vi.stubEnv('MTA_DMARC_REPORT_ADDRESS', 'off');
		vi.stubEnv('MTA_DMARC_RUA', '');
		expect(dmarcRuaFromEnv()).toBeUndefined();
	});
});

describe('relay apex SPF strings', () => {
	it('SES keeps its hard-fail include byte for byte', async () => {
		const result = await sesProvider.registerDomain(DOMAIN);
		expect(result.dnsRecords.spf).toEqual({
			type: 'TXT',
			host: '@',
			value: 'v=spf1 include:amazonses.com -all',
		});
	});

	it('Mandrill keeps its hard-fail include byte for byte', () => {
		expect(buildMandrillDnsRecords(DOMAIN).spf).toEqual({
			type: 'TXT',
			host: '@',
			value: 'v=spf1 include:spf.mandrillapp.com -all',
		});
	});

	it('ignores SPF_QUALIFIER, which governs only our own MTA pool', async () => {
		vi.stubEnv('SPF_QUALIFIER', '~all');
		try {
			const ses = await sesProvider.registerDomain(DOMAIN);
			expect(ses.dnsRecords.spf?.value).toBe('v=spf1 include:amazonses.com -all');
			expect(buildMandrillDnsRecords(DOMAIN).spf?.value).toBe(
				'v=spf1 include:spf.mandrillapp.com -all'
			);
		} finally {
			vi.unstubAllEnvs();
		}
	});
});
