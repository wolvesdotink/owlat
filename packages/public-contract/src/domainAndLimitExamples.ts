/**
 * The examples of the domain and limit operations, spread into
 * `OPERATION_EXAMPLES` (`./examples.ts`), which says what every example must
 * hold.
 */

import type { OperationExample } from './examples';
import type { ApiResponse, DomainCheckRequest, SendingDomainSetup, SendLimits } from './types';

export const DOMAIN_AND_LIMIT_EXAMPLES = {
	listDomains: {
		response: {
			data: [
				{
					id: 'k57d0main0000000000000000000000',
					domain: 'news.example.com',
					status: 'failed',
					lastCheckedAt: '2026-11-21T07:30:00.000Z',
					records: [
						{
							purpose: 'dkim',
							type: 'CNAME',
							host: 's1._domainkey.news.example.com',
							value: 's1.dkim.owlat.example',
							priority: null,
							state: 'wrong',
							foundValue: 'old.dkim.example.net',
							optional: false,
						},
						{
							purpose: 'dkim',
							type: 'TXT',
							host: 'e1763700000000._domainkey.news.example.com',
							value: 'v=DKIM1; k=ed25519; p=11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=',
							priority: null,
							state: 'missing',
							foundValue: null,
							optional: true,
						},
						{
							purpose: 'dmarc',
							type: 'TXT',
							host: '_dmarc.news.example.com',
							value: 'v=DMARC1; p=none',
							priority: null,
							state: 'missing',
							foundValue: null,
							optional: false,
						},
						{
							purpose: 'mail_from',
							type: 'MX',
							host: 'bounce.news.example.com',
							value: 'feedback.owlat.example',
							priority: 10,
							state: 'found',
							foundValue: null,
							optional: false,
						},
					],
				},
			],
		} satisfies ApiResponse<SendingDomainSetup[]>,
	},
	verifyDomain: {
		response: {
			data: {
				id: 'k57d0ma1n00000000000000000000',
				domain: 'news.example.com',
				status: 'failed',
				lastCheckedAt: '2026-11-21T07:30:00.000Z',
				requestedAt: '2026-11-23T15:30:00.000Z',
			},
		} satisfies ApiResponse<DomainCheckRequest>,
	},
	getLimits: {
		response: {
			data: {
				dailySends: {
					isEnabled: true,
					limit: 50_000,
					used: 1_204,
					remaining: 48_796,
					resetsAt: '2026-11-24T00:00:00.000Z',
				},
				recipientSends: {
					isEnabled: true,
					limit: 5,
					windowSeconds: 3600,
					usage: {
						email: 'ada@example.com',
						templateId: 'k57t3mpl4te0000000000000000000',
						slug: 'password-reset',
						isExempt: false,
						used: 2,
						remaining: 3,
						resetsAt: '2026-11-23T15:54:00.000Z',
					},
				},
			},
		} satisfies ApiResponse<SendLimits>,
	},
} satisfies Record<string, OperationExample>;
