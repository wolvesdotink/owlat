/**
 * MTA sending-domain provider `registerDomain` — audit PR-74 (3).
 *
 * DKIM alignment is what carries DMARC (RFC 7489 §3.1): the DNS record the
 * customer publishes for the generated DKIM key MUST live at the
 * `<selector>._domainkey` host under the From-domain, so the `d=`/selector in the
 * outbound DKIM signature resolves and aligns with the RFC5322.From domain.
 *
 * This locks the host construction (and the selector echoed onto the identity)
 * with the real `mtaProvider.registerDomain`, the MTA HTTP client stubbed to a
 * fixed selector so the assertion is on the host wiring, not the network call.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Stub the MTA HTTP client so `registerDomain` returns a deterministic selector
// without a live `/dkim/<domain>/register` call.
const registerDomainMock = vi.fn();
vi.mock('../../../../lib/emailProviders/mtaIdentity', () => ({
	createMtaIdentityManager: () => ({
		registerDomain: registerDomainMock,
		deleteDomain: vi.fn(),
	}),
}));

import { mtaProvider } from '../index';

describe('mtaProvider.registerDomain — DKIM DNS host (PR-74)', () => {
	beforeEach(() => {
		registerDomainMock.mockReset();
		// Keep all optional records (SPF/return-path/TLS-RPT) out of the bundle so
		// the assertion is purely on the DKIM host.
		delete process.env['MTA_SPF_INCLUDE'];
		delete process.env['MTA_RETURN_PATH_DOMAIN'];
		delete process.env['MTA_IP_POOLS'];
		delete process.env['MTA_TLSRPT_RUA'];
		delete process.env['MTA_DMARC_RUA'];
		delete process.env['SPF_QUALIFIER'];
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('emits the DKIM TXT record at `<selector>._domainkey`', async () => {
		registerDomainMock.mockResolvedValue({
			selector: 's1750000000',
			dnsRecord: 'v=DKIM1; k=rsa; p=MIGfMA0FAKEKEY',
		});

		const result = await mtaProvider.registerDomain('acme.com');

		expect(result.dnsRecords.dkim).toHaveLength(1);
		const dkim = result.dnsRecords.dkim![0]!;
		expect(dkim.type).toBe('TXT');
		expect(dkim.host).toBe('s1750000000._domainkey');
		expect(dkim.value).toBe('v=DKIM1; k=rsa; p=MIGfMA0FAKEKEY');
	});

	it('echoes the same selector onto the persisted MTA identity', async () => {
		registerDomainMock.mockResolvedValue({
			selector: 'sel-xyz',
			dnsRecord: 'v=DKIM1; k=rsa; p=ABC',
		});

		const result = await mtaProvider.registerDomain('acme.com');

		expect(result.identity).toEqual({ kind: 'mta', dkimSelector: 'sel-xyz' });
		// The host derives from that exact selector — they must not drift.
		expect(result.dnsRecords.dkim![0]!.host).toBe(`${result.identity.dkimSelector}._domainkey`);
	});

	it('publishes the DMARC record at `_dmarc` (the alignment carries DMARC)', async () => {
		registerDomainMock.mockResolvedValue({ selector: 's1', dnsRecord: 'v=DKIM1; p=K' });

		const result = await mtaProvider.registerDomain('acme.com');

		expect(result.dnsRecords.dmarc!.host).toBe('_dmarc');
		expect(result.dnsRecords.dmarc!.value).toContain('v=DMARC1');
	});
});
