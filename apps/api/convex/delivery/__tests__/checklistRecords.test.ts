import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildMtaStsTxtValue, mtaStsPolicyId } from '@owlat/shared/mtaStsPolicy';
import type { Doc } from '../../_generated/dataModel';
import { deploymentSetupValuesForItem, domainSetupValuesForItem } from '../checklistRecords';

describe('Deliverability Center setup values', () => {
	afterEach(() => vi.unstubAllEnvs());

	it('represents TLS-RPT and TLSA independently when both are configured', () => {
		const domain = {
			domain: 'example.test',
			dnsRecords: {
				tlsRpt: {
					type: 'TXT',
					host: '_smtp._tls',
					value: 'v=TLSRPTv1; rua=mailto:tls@example.test',
				},
				tlsa: {
					type: 'TLSA',
					host: '_25._tcp.mail',
					value: '3 1 1 abcdef',
				},
			},
		} as unknown as Doc<'domains'>;
		expect(domainSetupValuesForItem('domain.tls_rpt', domain, [], null)).toMatchObject([
			{ kind: 'dns_record', recordType: 'TXT', name: '_smtp._tls.example.test' },
		]);
		expect(domainSetupValuesForItem('domain.tlsa', domain, [], null)).toMatchObject([
			{ kind: 'dns_record', recordType: 'TLSA', name: '_25._tcp.mail.example.test' },
		]);
	});

	it('emits one additive SPF fragment for every IPv6 policy host', () => {
		const warming = {
			ips: [
				{ ip: '2001:db8::2', ipv6Spf: { domain: 'bounce.example.test' } },
				{ ip: '2001:db8::1', ipv6Spf: { domain: 'bounce.example.test' } },
			],
		} as unknown as Doc<'warmingState'>;
		const records = deploymentSetupValuesForItem('deployment.ipv6_spf', warming);
		expect(records).toEqual([
			expect.objectContaining({
				kind: 'spf_mechanisms',
				domain: 'bounce.example.test',
				mechanisms: ['ip6:2001:db8::1', 'ip6:2001:db8::2'],
				instruction: expect.stringContaining('existing SPF policy'),
			}),
		]);
		expect(
			records.filter(
				(record) => record.kind === 'spf_mechanisms' && record.domain === 'bounce.example.test'
			)
		).toHaveLength(1);
		expect(records[0]).not.toHaveProperty('recordType');
		expect(records[0]).not.toHaveProperty('ttl');
	});

	it.each(['~all', 'all'])(
		'renders the strict replacement for a staged domain SPF record ending in %s',
		(qualifier) => {
			const domain = {
				domain: 'example.test',
				dnsRecords: {
					spf: {
						type: 'TXT',
						host: '@',
						value: `v=spf1 include:sender.example ${qualifier}`,
					},
				},
			} as unknown as Doc<'domains'>;

			expect(domainSetupValuesForItem('domain.spf', domain, [], null)).toMatchObject([
				{
					kind: 'dns_record',
					name: 'example.test',
					recordType: 'TXT',
					value: 'v=spf1 include:sender.example -all',
				},
			]);
		}
	);

	it('derives MTA-STS guidance from the deployment EHLO policy source', () => {
		vi.stubEnv('EHLO_HOSTNAME', 'canonical.example.test');
		const domain = {
			domain: 'example.test',
			dnsRecords: {},
		} as unknown as Doc<'domains'>;
		const settings = { mtaStsMode: 'enforce' } as unknown as Doc<'instanceSettings'>;
		const warming = {
			ips: [{ ip: '203.0.113.10', fcrdns: { ehlo: 'per-ip.example.test' } }],
		} as unknown as Doc<'warmingState'>;
		expect(deploymentSetupValuesForItem('deployment.fcrdns', warming)[0]).toMatchObject({
			kind: 'dns_record',
			name: 'per-ip.example.test',
		});
		const records = domainSetupValuesForItem('domain.mta_sts', domain, [], settings);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			kind: 'dns_record',
			value: buildMtaStsTxtValue(mtaStsPolicyId('enforce', ['canonical.example.test'])),
		});
		expect(records[0]?.kind === 'dns_record' ? records[0].value : '').not.toContain(
			'per-ip.example.test'
		);
	});
});
