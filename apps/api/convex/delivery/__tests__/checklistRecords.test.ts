import { describe, expect, it } from 'vitest';
import type { Doc } from '../../_generated/dataModel';
import { domainRecordsForItem } from '../checklistRecords';

describe('Deliverability Center copyable records', () => {
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
		expect(domainRecordsForItem('domain.tls_rpt', domain, [], null, null)).toMatchObject([
			{ type: 'TXT', name: '_smtp._tls.example.test' },
		]);
		expect(domainRecordsForItem('domain.tlsa', domain, [], null, null)).toMatchObject([
			{ type: 'TLSA', name: '_25._tcp.mail.example.test' },
		]);
	});
});
