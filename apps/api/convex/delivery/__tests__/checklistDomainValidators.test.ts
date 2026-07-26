import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../checklistProviderDetection', () => ({
	detectDomainDnsProvider: vi.fn(async () => null),
	dnsProviderObservation: vi.fn(() => []),
}));
vi.mock('../../domains/dnsVerification', () => ({
	runDnsLookups: vi.fn(),
}));

import { runDnsLookups } from '../../domains/dnsVerification';
import { observeDomainCheck } from '../checklistDomainValidators';
import type { ChecklistVerificationContext } from '../checklistValidatorTypes';

function context(
	domain: Record<string, unknown>,
	dnsRecords: Record<string, unknown>
): ChecklistVerificationContext {
	return {
		domain: {
			domain: 'example.test',
			providerType: 'mta',
			dnsRecords,
			...domain,
		},
		settings: null,
		warming: null,
		routes: [],
		relayIdentities: [],
		tracking: [],
		postmaster: null,
	} as unknown as ChecklistVerificationContext;
}

describe('domain checklist validation', () => {
	beforeEach(() => vi.mocked(runDnsLookups).mockReset());
	afterEach(() => vi.unstubAllEnvs());

	it.each(['~all', '?all', 'all'])(
		'fails a verified SPF policy ending in %s',
		async (qualifier) => {
			const policy = `v=spf1 include:sender.example ${qualifier}`;
			vi.mocked(runDnsLookups).mockResolvedValue({
				spf: { verified: true, foundValue: policy },
			} as never);
			await expect(
				observeDomainCheck(
					{} as never,
					'domain.spf',
					context({}, { spf: { type: 'TXT', host: '@', value: policy } }),
					false
				)
			).resolves.toMatchObject({
				status: 'fail',
				diagnostic: expect.stringContaining('must end in -all'),
			});
		}
	);

	it('verifies the same strict SPF replacement shown for a staged soft-fail record', async () => {
		vi.mocked(runDnsLookups).mockResolvedValue({
			spf: {
				verified: true,
				foundValue: 'v=spf1 include:sender.example -all',
			},
		} as never);
		await expect(
			observeDomainCheck(
				{} as never,
				'domain.spf',
				context(
					{},
					{ spf: { type: 'TXT', host: '@', value: 'v=spf1 include:sender.example ~all' } }
				),
				false
			)
		).resolves.toMatchObject({ status: 'pass' });
		expect(runDnsLookups).toHaveBeenCalledWith(
			'example.test',
			expect.objectContaining({
				spf: expect.objectContaining({ value: 'v=spf1 include:sender.example -all' }),
			})
		);
	});

	it('does not pass strict SPF when the DNS result carries a failure diagnostic', async () => {
		vi.mocked(runDnsLookups).mockResolvedValue({
			spf: {
				verified: true,
				foundValue: 'v=spf1 include:sender.example -all',
				error: 'Resolver validation failed.',
			},
		} as never);
		await expect(
			observeDomainCheck(
				{} as never,
				'domain.spf',
				context(
					{},
					{ spf: { type: 'TXT', host: '@', value: 'v=spf1 include:sender.example -all' } }
				),
				false
			)
		).resolves.toMatchObject({ status: 'fail' });
	});

	it('does not pass DKIM when a later selector has a definite mismatch', async () => {
		vi.mocked(runDnsLookups).mockResolvedValue({
			dkim: [
				{ verified: true, foundValue: 'v=DKIM1; p=first' },
				{ verified: false, error: 'The second selector value does not match.' },
			],
		} as never);
		await expect(
			observeDomainCheck(
				{} as never,
				'domain.dkim',
				context(
					{},
					{
						dkim: [
							{ type: 'TXT', host: 's1._domainkey', value: 'v=DKIM1; p=first' },
							{ type: 'TXT', host: 's2._domainkey', value: 'v=DKIM1; p=second' },
						],
					}
				),
				false
			)
		).resolves.toMatchObject({ status: 'fail' });
	});

	it('does not pass DMARC solely because its own record is verified', async () => {
		vi.mocked(runDnsLookups).mockResolvedValue({
			spf: { verified: false, error: 'The SPF value does not match.' },
			dkim: [{ verified: true, foundValue: 'v=DKIM1; p=key' }],
			dmarc: { verified: true, foundValue: 'v=DMARC1; p=reject' },
		} as never);
		await expect(
			observeDomainCheck(
				{} as never,
				'domain.dmarc',
				context(
					{},
					{
						spf: { type: 'TXT', host: '@', value: 'v=spf1 -all' },
						dkim: [{ type: 'TXT', host: 's1._domainkey', value: 'v=DKIM1; p=key' }],
						dmarc: { type: 'TXT', host: '_dmarc', value: 'v=DMARC1; p=reject' },
					}
				),
				false
			)
		).resolves.toMatchObject({ status: 'fail' });
	});

	it('does not pass DMARC without any DKIM selector evidence', async () => {
		vi.mocked(runDnsLookups).mockResolvedValue({
			spf: { verified: true, foundValue: 'v=spf1 -all' },
			dkim: [],
			dmarc: { verified: true, foundValue: 'v=DMARC1; p=reject' },
		} as never);
		await expect(
			observeDomainCheck(
				{} as never,
				'domain.dmarc',
				context(
					{},
					{
						spf: { type: 'TXT', host: '@', value: 'v=spf1 -all' },
						dkim: [],
						dmarc: { type: 'TXT', host: '_dmarc', value: 'v=DMARC1; p=reject' },
					}
				),
				false
			)
		).resolves.toMatchObject({ status: 'pending-dns' });
	});

	it('does not pass DMARC without SPF evidence', async () => {
		vi.mocked(runDnsLookups).mockResolvedValue({
			dkim: [{ verified: true, foundValue: 'v=DKIM1; p=key' }],
			dmarc: { verified: true, foundValue: 'v=DMARC1; p=reject' },
		} as never);
		await expect(
			observeDomainCheck(
				{} as never,
				'domain.dmarc',
				context(
					{},
					{
						dkim: [{ type: 'TXT', host: 's1._domainkey', value: 'v=DKIM1; p=key' }],
						dmarc: { type: 'TXT', host: '_dmarc', value: 'v=DMARC1; p=reject' },
					}
				),
				false
			)
		).resolves.toMatchObject({ status: 'pending-dns' });
	});

	it('requires successful MTA synchronization for a verified custom return path', async () => {
		vi.mocked(runDnsLookups).mockResolvedValue({
			mailFrom: [{ verified: true, foundValue: 'v=spf1 ip4:203.0.113.10 -all' }],
		} as never);
		const observation = await observeDomainCheck(
			{} as never,
			'domain.return_path',
			context(
				{
					returnPathHost: 'bounce.example.test',
					returnPathHostSyncError: 'MTA registration rejected the host',
				},
				{
					mailFrom: [
						{
							type: 'TXT',
							hostname: 'bounce.example.test',
							value: 'v=spf1 ip4:203.0.113.10 -all',
						},
					],
				}
			),
			false
		);
		expect(observation).toMatchObject({
			status: 'fail',
			diagnostic: expect.stringContaining('not active at the sending provider'),
		});
	});

	it('rejects verified legacy records carrying a failure diagnostic', async () => {
		vi.stubEnv('MTA_RETURN_PATH_DOMAIN', 'bounce.global.test');
		vi.mocked(runDnsLookups).mockResolvedValue({
			mailFrom: [
				{
					verified: true,
					foundValue: 'v=spf1 ip4:203.0.113.10 -all',
					error: 'The live record does not authorize the active pool.',
				},
			],
		} as never);
		const observation = await observeDomainCheck(
			{} as never,
			'domain.return_path',
			context(
				{},
				{
					mailFrom: [
						{
							type: 'TXT',
							hostname: 'bounce.global.test',
							value: 'v=spf1 ip4:203.0.113.10 -all',
						},
					],
				}
			),
			false
		);
		expect(observation.status).toBe('fail');
		expect(observation.diagnostic).toContain('does not authorize');
	});

	it('accepts a verified active legacy MTA return-path contract', async () => {
		vi.stubEnv('MTA_RETURN_PATH_DOMAIN', 'bounce.global.test');
		vi.mocked(runDnsLookups).mockResolvedValue({
			mailFrom: [{ verified: true, foundValue: 'v=spf1 ip4:203.0.113.10 -all' }],
		} as never);
		const observation = await observeDomainCheck(
			{} as never,
			'domain.return_path',
			context(
				{},
				{
					mailFrom: [
						{
							type: 'TXT',
							hostname: 'bounce.global.test',
							value: 'v=spf1 ip4:203.0.113.10 -all',
						},
					],
				}
			),
			false
		);
		expect(observation.status).toBe('pass');
	});

	it('accepts the active default SES mail-from contract', async () => {
		vi.mocked(runDnsLookups).mockResolvedValue({
			mailFrom: [
				{ verified: true, foundValue: '10 feedback-smtp.eu-west-1.amazonses.com' },
				{ verified: true, foundValue: 'v=spf1 include:amazonses.com ~all' },
			],
		} as never);
		const observation = await observeDomainCheck(
			{} as never,
			'domain.return_path',
			context(
				{ providerType: 'ses' },
				{
					mailFrom: [
						{ type: 'MX', host: 'mail', value: 'feedback-smtp.eu-west-1.amazonses.com' },
						{ type: 'TXT', host: 'mail', value: 'v=spf1 include:amazonses.com ~all' },
					],
				}
			),
			false
		);
		expect(observation.status).toBe('pass');
	});

	it('does not pass SES while custom mail-from reflection has failed', async () => {
		vi.mocked(runDnsLookups).mockResolvedValue({
			mailFrom: [
				{ verified: true, foundValue: '10 feedback-smtp.eu-west-1.amazonses.com' },
				{ verified: true, foundValue: 'v=spf1 include:amazonses.com ~all' },
			],
		} as never);
		const observation = await observeDomainCheck(
			{} as never,
			'domain.return_path',
			context(
				{
					providerType: 'ses',
					returnPathHost: 'bounce.example.test',
					returnPathHostSyncError: 'SES still uses mail.example.test',
				},
				{
					mailFrom: [
						{
							type: 'MX',
							hostname: 'bounce.example.test',
							value: 'feedback-smtp.eu-west-1.amazonses.com',
						},
						{
							type: 'TXT',
							hostname: 'bounce.example.test',
							value: 'v=spf1 include:amazonses.com ~all',
						},
					],
				}
			),
			false
		);
		expect(observation).toMatchObject({
			status: 'fail',
			diagnostic: expect.stringContaining('not active at the sending provider'),
		});
	});

	it('rejects stale legacy MTA records for a different global host', async () => {
		vi.stubEnv('MTA_RETURN_PATH_DOMAIN', 'active.global.test');
		vi.mocked(runDnsLookups).mockResolvedValue({
			mailFrom: [{ verified: true, foundValue: 'v=spf1 ip4:203.0.113.10 -all' }],
		} as never);
		const observation = await observeDomainCheck(
			{} as never,
			'domain.return_path',
			context(
				{},
				{
					mailFrom: [
						{
							type: 'TXT',
							hostname: 'stale.global.test',
							value: 'v=spf1 ip4:203.0.113.10 -all',
						},
					],
				}
			),
			false
		);
		expect(observation.status).toBe('fail');
		expect(observation.diagnostic).toContain('active provider return-path');
	});

	it('fails when MAIL FROM MX passes but SPF has a definite mismatch', async () => {
		vi.stubEnv('MTA_RETURN_PATH_DOMAIN', 'bounce.global.test');
		vi.mocked(runDnsLookups).mockResolvedValue({
			mailFrom: [
				{ verified: true, foundValue: '10 mail.example.test' },
				{ verified: false, error: 'The SPF value does not match the active pool.' },
			],
		} as never);
		const observation = await observeDomainCheck(
			{} as never,
			'domain.return_path',
			context(
				{},
				{
					mailFrom: [
						{ type: 'MX', hostname: 'bounce.global.test', value: 'mail.example.test' },
						{
							type: 'TXT',
							hostname: 'bounce.global.test',
							value: 'v=spf1 ip4:203.0.113.10 -all',
						},
					],
				}
			),
			false
		);
		expect(observation.status).toBe('fail');
	});

	it('keeps an unresolved MAIL FROM SPF record pending until the final retry', async () => {
		vi.stubEnv('MTA_RETURN_PATH_DOMAIN', 'bounce.global.test');
		vi.mocked(runDnsLookups).mockResolvedValue({
			mailFrom: [
				{ verified: true, foundValue: '10 mail.example.test' },
				{ verified: false, error: 'No DNS record found yet' },
			],
		} as never);
		const returnPathContext = context(
			{},
			{
				mailFrom: [
					{ type: 'MX', hostname: 'bounce.global.test', value: 'mail.example.test' },
					{
						type: 'TXT',
						hostname: 'bounce.global.test',
						value: 'v=spf1 ip4:203.0.113.10 -all',
					},
				],
			}
		);
		await expect(
			observeDomainCheck({} as never, 'domain.return_path', returnPathContext, false)
		).resolves.toMatchObject({ status: 'pending-dns' });
		await expect(
			observeDomainCheck({} as never, 'domain.return_path', returnPathContext, true)
		).resolves.toMatchObject({ status: 'fail' });
	});
});
