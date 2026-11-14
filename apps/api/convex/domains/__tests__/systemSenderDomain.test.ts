/**
 * What `owlat doctor` and the installer print for the system sender's domain:
 * the records the Domains page stores for it, with what the last DNS check
 * found.
 */

import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import { modules } from '../../__tests__/testModules';

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('systemSenderDomain.dnsStatus', () => {
	it('says when no system sender is configured', async () => {
		const t = convexTest(schema, modules);
		expect(await t.query(internal.domains.systemSenderDomain.dnsStatus, {})).toEqual({
			state: 'not_configured',
		});
	});

	it('says when the domain is not a sending domain', async () => {
		vi.stubEnv('DEFAULT_FROM_EMAIL', 'noreply@Mail.Example.org');
		const t = convexTest(schema, modules);
		expect(await t.query(internal.domains.systemSenderDomain.dnsStatus, {})).toEqual({
			state: 'not_registered',
			domain: 'mail.example.org',
		});
	});

	it('lists the stored records and what the last check found', async () => {
		vi.stubEnv('DEFAULT_FROM_DOMAIN', 'mail.example.org');
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('domains', {
				domain: 'mail.example.org',
				status: 'pending',
				providerType: 'mta',
				dnsRecords: {
					spf: { type: 'TXT', hostname: 'mail.example.org', value: 'v=spf1 a -all' },
					dkim: [
						{
							type: 'TXT',
							hostname: 's1._domainkey.mail.example.org',
							value: 'v=DKIM1; k=rsa; p=AAAA',
						},
					],
					dmarc: { type: 'TXT', hostname: '_dmarc.mail.example.org', value: 'v=DMARC1; p=none' },
				},
				verificationResults: {
					spf: { verified: true, lastChecked: 1 },
					dkim: [{ verified: false, lastChecked: 1 }],
				},
				createdAt: 1,
				updatedAt: 1,
			});
		});

		expect(await t.query(internal.domains.systemSenderDomain.dnsStatus, {})).toEqual({
			state: 'pending',
			domain: 'mail.example.org',
			records: [
				{
					label: 'SPF',
					type: 'TXT',
					name: 'mail.example.org',
					value: 'v=spf1 a -all',
					verified: true,
				},
				{
					label: 'DKIM',
					type: 'TXT',
					name: 's1._domainkey.mail.example.org',
					value: 'v=DKIM1; k=rsa; p=AAAA',
					verified: false,
				},
				{
					label: 'DMARC',
					type: 'TXT',
					name: '_dmarc.mail.example.org',
					value: 'v=DMARC1; p=none',
					verified: null,
				},
			],
		});
	});
});
