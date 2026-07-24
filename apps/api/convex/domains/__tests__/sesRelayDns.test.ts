import { describe, expect, it } from 'vitest';
import { buildHybridSesRelayDnsRecords } from '../sesRelay';

describe('hybrid SES relay DNS plan', () => {
	it('publishes one merged apex SPF and keeps the primary DMARC authoritative', () => {
		const result = buildHybridSesRelayDnsRecords(
			{
				spf: { type: 'TXT', host: '@', value: 'v=spf1 ip4:203.0.113.10 -all' },
				dmarc: { type: 'TXT', host: '_dmarc', value: 'v=DMARC1; p=reject' },
			},
			{
				spf: { type: 'TXT', host: '@', value: 'v=spf1 include:amazonses.com ~all' },
				dkim: [{ type: 'CNAME', host: 'ses._domainkey', value: 'ses.dkim.amazonses.com' }],
				dmarc: { type: 'TXT', host: '_dmarc', value: 'v=DMARC1; p=none' },
				mailFrom: [
					{
						type: 'MX',
						host: 'ses-mail',
						value: 'feedback-smtp.eu-central-1.amazonses.com',
						priority: 10,
					},
				],
			}
		);

		expect(result.spf?.value).toBe('v=spf1 ip4:203.0.113.10 include:amazonses.com -all');
		expect(result.dmarc).toBeUndefined();
		expect(result.dkim).toHaveLength(1);
		expect(result.mailFrom?.[0]?.host).toBe('ses-mail');
	});

	it('never publishes an SES-only apex SPF when no primary policy is known', () => {
		const result = buildHybridSesRelayDnsRecords(
			{},
			{
				spf: { type: 'TXT', host: '@', value: 'v=spf1 include:amazonses.com ~all' },
				dkim: [{ type: 'CNAME', host: 'ses._domainkey', value: 'ses.dkim.amazonses.com' }],
			}
		);
		expect(result.spf).toBeUndefined();
		expect(result.dkim).toHaveLength(1);
	});
});
