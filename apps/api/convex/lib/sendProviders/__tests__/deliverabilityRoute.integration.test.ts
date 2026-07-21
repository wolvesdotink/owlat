import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { createTestDomain } from '../../../__tests__/factories';
import { resolveSendRouteFromDb } from '../route';

vi.mock('../../sessionOrganization', async () => {
	const actual = await vi.importActual('../../sessionOrganization');
	return { ...actual, getSingletonOrganizationId: vi.fn().mockResolvedValue('org-a') };
});

const modules = import.meta.glob('../../../**/*.*s');
const NOW = 10_000_000;

beforeEach(() => {
	vi.stubEnv('MTA_API_URL', 'https://mta.internal');
	vi.stubEnv('MTA_API_KEY', 'test-key');
	vi.stubEnv('AWS_SES_ACCESS_KEY_ID', 'access');
	vi.stubEnv('AWS_SES_SECRET_ACCESS_KEY', 'secret');
});

afterEach(() => vi.unstubAllEnvs());

async function seedRouteState(options: {
	withSesIdentity: boolean;
	primaryProvider?: 'mta' | 'ses';
}) {
	const t = convexTest(schema, modules);
	await t.run(async (ctx) => {
		await ctx.db.insert('providerRoutes', {
			messageType: 'campaign',
			strategy: 'single',
			providers: [
				{ providerType: 'mta', isEnabled: true },
				{ providerType: 'ses', isEnabled: true },
			],
			deliverabilityFallback: {
				isEnabled: true,
				relayProviderType: 'ses',
				isWarmupOverflowEnabled: false,
			},
			createdAt: NOW,
			updatedAt: NOW,
		});
		const domainId = await ctx.db.insert(
			'domains',
			createTestDomain({
				domain: 'example.com',
				status: 'verified',
				providerType: options.primaryProvider ?? 'mta',
			})
		);
		if (options.withSesIdentity) {
			await ctx.db.insert('sendingDomainSesIdentities', {
				domainId,
				dkimTokens: ['one', 'two', 'three'],
				verificationToken: 'verified-token',
				dnsRecords: {
					spf: { type: 'TXT', host: '@', value: 'v=spf1 include:amazonses.com ~all' },
					dkim: ['one', 'two', 'three'].map((token) => ({
						type: 'CNAME' as const,
						host: `${token}._domainkey`,
						value: `${token}.dkim.amazonses.com`,
					})),
					mailFrom: [
						{ type: 'MX', host: 'mail', value: 'feedback-smtp.example.com', priority: 10 },
						{ type: 'TXT', host: 'mail', value: 'v=spf1 include:amazonses.com ~all' },
					],
				},
				verificationResults: {
					spf: { verified: true, lastChecked: NOW },
					dkim: ['one', 'two', 'three'].map(() => ({ verified: true, lastChecked: NOW })),
					mailFrom: [
						{ verified: true, lastChecked: NOW },
						{ verified: true, lastChecked: NOW },
					],
					sesStatus: 'Success',
				},
				isProviderVerified: true,
				verifiedAt: NOW,
				createdAt: NOW,
				updatedAt: NOW,
			});
		}
		for (const provider of ['gmail', 'microsoft'] as const) {
			await ctx.db.insert('deliverabilityRouteStates', {
				organizationId: 'org-a',
				destinationProvider: provider,
				isFallbackActive: provider === 'gmail',
				signals:
					provider === 'gmail'
						? [{ source: 'breaker_open', severity: 'critical', observedAt: NOW }]
						: [],
				fallbackActiveSince: provider === 'gmail' ? NOW : undefined,
				snapshotGeneratedAt: NOW,
				expiresAt: NOW + 86_400_000,
				updatedAt: NOW,
			});
		}
	});
	return t;
}

describe('DB-backed deliverability route verification', () => {
	it('routes only the affected provider slice through a current SES identity', async () => {
		const t = await seedRouteState({ withSesIdentity: true });
		await t.run(async (ctx) => {
			await ctx.db.insert('destinationProviderDomains', {
				organizationId: 'org-a',
				domain: 'workspace.example',
				destinationProvider: 'gmail',
				observedAt: NOW,
				expiresAt: NOW + 86_400_000,
			});
		});
		expect(
			await t.run((ctx) =>
				resolveSendRouteFromDb(ctx, 'campaign', {
					to: 'person@gmail.com',
					from: 'Owlat <sender@example.com>',
					now: NOW,
				})
			)
		).toMatchObject({
			providerType: 'ses',
			source: 'deliverability_fallback',
			deliverabilityReason: 'breaker_open',
		});
		expect(
			await t.run((ctx) =>
				resolveSendRouteFromDb(ctx, 'campaign', {
					to: 'person@outlook.com',
					from: 'Owlat <sender@example.com>',
					now: NOW,
				})
			)
		).toMatchObject({ providerType: 'mta', source: 'org_config' });
		expect(
			await t.run((ctx) =>
				resolveSendRouteFromDb(ctx, 'campaign', {
					to: 'person@workspace.example',
					from: 'Owlat <sender@example.com>',
					now: NOW,
				})
			)
		).toMatchObject({
			providerType: 'ses',
			source: 'deliverability_fallback',
		});
	});

	it('accepts explicit SES relay proof while the primary domain remains MTA-owned', async () => {
		const t = await seedRouteState({ withSesIdentity: true, primaryProvider: 'mta' });
		const domain = await t.run((ctx) => ctx.db.query('domains').first());
		expect(domain?.providerType).toBe('mta');
		expect(
			await t.run((ctx) =>
				resolveSendRouteFromDb(ctx, 'campaign', {
					to: 'person@gmail.com',
					from: 'sender@example.com',
					now: NOW,
				})
			)
		).toMatchObject({ providerType: 'ses', source: 'deliverability_fallback' });
	});

	it('refuses the affected slice when SES identity proof is absent', async () => {
		const t = await seedRouteState({ withSesIdentity: false });
		await expect(
			t.run((ctx) =>
				resolveSendRouteFromDb(ctx, 'campaign', {
					to: 'person@gmail.com',
					from: 'sender@example.com',
					now: NOW,
				})
			)
		).rejects.toThrow(/verify this sending domain/i);
	});

	it('ignores an expired signal instead of creating a new relay decision', async () => {
		const t = await seedRouteState({ withSesIdentity: true });
		expect(
			await t.run((ctx) =>
				resolveSendRouteFromDb(ctx, 'campaign', {
					to: 'person@gmail.com',
					from: 'sender@example.com',
					now: NOW + 11 * 60 * 1000,
				})
			)
		).toMatchObject({ providerType: 'mta', source: 'org_config' });
	});
});
