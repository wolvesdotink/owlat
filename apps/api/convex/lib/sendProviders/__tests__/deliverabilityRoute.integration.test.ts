import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../../schema';
import { createTestDomain } from '../../../__tests__/factories';
import {
	resolveGovernedRelayRouteFromDb,
	resolveLastMileRoutePlanFromDb,
	resolveSendRouteFromDb,
} from '../route';

vi.mock('../../sessionOrganization', async () => {
	const actual = await vi.importActual('../../sessionOrganization');
	return { ...actual, getSingletonOrganizationId: vi.fn().mockResolvedValue('org-a') };
});

const modules = import.meta.glob('../../../**/*.*s');
const NOW = 10_000_000;

beforeEach(() => {
	vi.stubEnv('MTA_API_URL', 'https://mta.internal');
	vi.stubEnv('MTA_API_KEY', 'test-key');
	vi.stubEnv('AWS_SES_REGION', 'us-east-1');
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

	it('never reports an advisory reading as the fallback reason when both are persisted', async () => {
		// This is exactly what applySnapshot's hysteresis branch writes: the
		// actionable trigger is PRESERVED while the advisory reading is REFRESHED
		// from the latest snapshot. Ordering the advisory reading first makes the
		// actionable filter load-bearing — without it the operator would be told
		// "blocklist lookup unavailable" caused a relay fallback that a confirmed
		// listing actually caused.
		const t = await seedRouteState({ withSesIdentity: true });
		await t.run(async (ctx) => {
			const state = await ctx.db
				.query('deliverabilityRouteStates')
				.withIndex('by_org_provider', (q) =>
					q.eq('organizationId', 'org-a').eq('destinationProvider', 'gmail')
				)
				.first();
			if (!state) throw new Error('missing gmail route state');
			await ctx.db.patch(state._id, {
				signals: [
					{ source: 'dnsbl_unknown', severity: 'warning', observedAt: NOW },
					{ source: 'dnsbl_listed', severity: 'critical', observedAt: NOW },
				],
			});
		});
		const route = await t.run((ctx) =>
			resolveSendRouteFromDb(ctx, 'campaign', {
				to: 'person@gmail.com',
				from: 'Owlat <sender@example.com>',
				now: NOW,
			})
		);
		expect(route).toMatchObject({
			providerType: 'ses',
			source: 'deliverability_fallback',
			deliverabilityReason: 'dnsbl_listed',
		});
		expect(route?.deliverabilityReason).not.toBe('dnsbl_unknown');
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

	it('authorizes verified SES DKIM/MAIL FROM when primary SPF is explicitly manual', async () => {
		const t = await seedRouteState({ withSesIdentity: true, primaryProvider: 'mta' });
		await t.run(async (ctx) => {
			const identity = await ctx.db.query('sendingDomainSesIdentities').first();
			if (!identity?.dnsRecords || !identity.verificationResults) throw new Error('missing proof');
			await ctx.db.patch(identity._id, {
				spfProofState: 'not_applicable_manual_primary',
				dnsRecords: {
					dkim: identity.dnsRecords.dkim,
					mailFrom: identity.dnsRecords.mailFrom,
				},
				verificationResults: {
					dkim: identity.verificationResults.dkim,
					mailFrom: identity.verificationResults.mailFrom,
					sesStatus: 'Success',
				},
			});
		});
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

	it('requires fresh SES relay proof when route priority selects SES before a signal', async () => {
		const t = await seedRouteState({ withSesIdentity: false });
		await t.run(async (ctx) => {
			const route = await ctx.db.query('providerRoutes').first();
			if (!route) throw new Error('missing route');
			await ctx.db.patch(route._id, {
				strategy: 'priority_failover',
				providers: [
					{ providerType: 'ses', isEnabled: true },
					{ providerType: 'mta', isEnabled: true },
				],
			});
			const gmail = await ctx.db
				.query('deliverabilityRouteStates')
				.withIndex('by_org_provider', (q) =>
					q.eq('organizationId', 'org-a').eq('destinationProvider', 'gmail')
				)
				.first();
			if (!gmail) throw new Error('missing gmail state');
			await ctx.db.patch(gmail._id, {
				isFallbackActive: false,
				signals: [],
				fallbackActiveSince: undefined,
			});
		});
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

	// `resolveRoute` throws for these states, and a throw crossing the action
	// boundary becomes a workpool failure that terminalizes the Send as
	// `WORKPOOL_FAILED`. Opening the org-wide safety circuit would then destroy
	// every in-flight campaign send instead of pausing it, so the governed
	// queries must report a deferral instead.
	it('reports an open org-wide safety circuit as a deferral, not a failure', async () => {
		const t = await seedRouteState({ withSesIdentity: true });
		await t.run(async (ctx) => {
			await ctx.db.insert('deliverabilityRouteStates', {
				organizationId: 'org-a',
				destinationProvider: 'all',
				isFallbackActive: true,
				signals: [{ source: 'breaker_open', severity: 'critical', observedAt: NOW }],
				fallbackActiveSince: NOW,
				snapshotGeneratedAt: NOW,
				expiresAt: NOW + 86_400_000,
				updatedAt: NOW,
			});
		});

		// The governed query reads the wall clock, so the seeded signal has to be
		// current for it to count as active.
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		try {
			expect(
				await t.run((ctx) =>
					resolveLastMileRoutePlanFromDb(ctx, 'campaign', {
						to: 'person@gmail.com',
						from: 'sender@example.com',
					})
				)
			).toMatchObject({ route: null, deferralCode: 'GLOBAL_DELIVERY_CIRCUIT_OPEN' });
		} finally {
			vi.useRealTimers();
		}
	});

	it('reports an unverified fallback relay as a deferral, not a failure', async () => {
		const t = await seedRouteState({ withSesIdentity: false });

		expect(
			await t.run((ctx) =>
				resolveGovernedRelayRouteFromDb(ctx, 'campaign', {
					to: 'person@gmail.com',
					from: 'sender@example.com',
					forceRelayReason: 'breaker_open',
				})
			)
		).toMatchObject({ route: null, deferralCode: 'DELIVERABILITY_RELAY_DOMAIN_UNVERIFIED' });
	});

	// Boolean -> share widening (D1). Legacy rows carry no `ownShare`, so every
	// case above already asserts the no-behaviour-change requirement; these two
	// pin the resolution contract itself at the resolver boundary.
	it('routes a legacy row exactly as the stored boolean, with no share written', async () => {
		const t = await seedRouteState({ withSesIdentity: true });
		const rows = await t.run((ctx) => ctx.db.query('deliverabilityRouteStates').collect());
		expect(rows.every((row) => row.ownShare === undefined && row.stream === undefined)).toBe(true);
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

	async function patchShare(
		t: Awaited<ReturnType<typeof seedRouteState>>,
		destinationProvider: 'gmail' | 'microsoft',
		ownShare: number
	) {
		await t.run(async (ctx) => {
			const state = await ctx.db
				.query('deliverabilityRouteStates')
				.withIndex('by_org_provider', (q) =>
					q.eq('organizationId', 'org-a').eq('destinationProvider', destinationProvider)
				)
				.first();
			if (!state) throw new Error(`missing ${destinationProvider} route state`);
			await ctx.db.patch(state._id, { ownShare });
		});
	}

	it('keeps honouring the infrastructure verdict when a whole-cell share is stored', async () => {
		// The MTA snapshot writes `isFallbackActive` from infrastructure health on
		// a ~10-minute cadence; the ramp controller writes `ownShare` hourly. A
		// stored ownShare = 1 must therefore NOT mask a live critical breaker for a
		// whole controller tick — the hard stop wins.
		const t = await seedRouteState({ withSesIdentity: true });
		await patchShare(t, 'gmail', 1);
		expect(
			await t.run((ctx) =>
				resolveSendRouteFromDb(ctx, 'campaign', {
					to: 'person@gmail.com',
					from: 'sender@example.com',
					now: NOW,
				})
			)
		).toMatchObject({
			providerType: 'ses',
			source: 'deliverability_fallback',
			deliverabilityReason: 'breaker_open',
		});
	});

	it('routes a whole-cell share on a HEALTHY row straight to the own MTA', async () => {
		const t = await seedRouteState({ withSesIdentity: true });
		await patchShare(t, 'microsoft', 1);
		expect(
			await t.run((ctx) =>
				resolveSendRouteFromDb(ctx, 'campaign', {
					to: 'person@outlook.com',
					from: 'sender@example.com',
					now: NOW,
				})
			)
		).toMatchObject({ providerType: 'mta', source: 'org_config' });
	});

	it('relays a partial share as a WHOLE cell today, and never on the share alone', async () => {
		// Pinning the pre-controller semantics explicitly so P3-2's per-message
		// split has to change an assertion rather than silently reinterpret the
		// field: a partial share on a degraded cell relays everything...
		const degraded = await seedRouteState({ withSesIdentity: true });
		await patchShare(degraded, 'gmail', 0.5);
		expect(
			await degraded.run((ctx) =>
				resolveSendRouteFromDb(ctx, 'campaign', {
					to: 'person@gmail.com',
					from: 'sender@example.com',
					now: NOW,
				})
			)
		).toMatchObject({
			providerType: 'ses',
			source: 'deliverability_fallback',
			deliverabilityReason: 'breaker_open',
		});
		// ...and a partial share on a HEALTHY cell relays nothing, because nothing
		// in this piece turns a share into a routing reason.
		const healthy = await seedRouteState({ withSesIdentity: true });
		await patchShare(healthy, 'microsoft', 0.5);
		expect(
			await healthy.run((ctx) =>
				resolveSendRouteFromDb(ctx, 'campaign', {
					to: 'person@outlook.com',
					from: 'sender@example.com',
					now: NOW,
				})
			)
		).toMatchObject({ providerType: 'mta', source: 'org_config' });
	});

	async function insertPerStreamRow(
		t: Awaited<ReturnType<typeof seedRouteState>>,
		destinationProvider: 'gmail' | 'all',
		ownShare: number
	) {
		await t.run(async (ctx) => {
			await ctx.db.insert('deliverabilityRouteStates', {
				organizationId: 'org-a',
				destinationProvider,
				stream: 'campaign',
				ownShare,
				// The controller's row carries the share and NOTHING else: signals are
				// the MTA snapshot's, written on the stream-less row.
				isFallbackActive: false,
				signals: [],
				snapshotGeneratedAt: NOW,
				expiresAt: NOW + 86_400_000,
				updatedAt: NOW,
			});
		});
	}

	it('still surfaces the stream-less infrastructure verdict when a per-stream row exists', async () => {
		// Row-selection shadowing: a per-stream (org, gmail, campaign) row must not
		// hide the stream-less gmail row the MTA snapshot writes the critical
		// breaker signal onto. Reading only the most specific row would silently
		// stop the relay fallback for campaign traffic.
		const t = await seedRouteState({ withSesIdentity: true });
		await insertPerStreamRow(t, 'gmail', 0.25);
		expect(
			await t.run((ctx) =>
				resolveSendRouteFromDb(ctx, 'campaign', {
					to: 'person@gmail.com',
					from: 'sender@example.com',
					now: NOW,
				})
			)
		).toMatchObject({
			providerType: 'ses',
			source: 'deliverability_fallback',
			deliverabilityReason: 'breaker_open',
		});
	});

	it('still defers on the org-wide circuit when a per-stream `all` row exists', async () => {
		const t = await seedRouteState({ withSesIdentity: true });
		await t.run(async (ctx) => {
			await ctx.db.insert('deliverabilityRouteStates', {
				organizationId: 'org-a',
				destinationProvider: 'all',
				isFallbackActive: true,
				signals: [{ source: 'breaker_open', severity: 'critical', observedAt: NOW }],
				fallbackActiveSince: NOW,
				snapshotGeneratedAt: NOW,
				expiresAt: NOW + 86_400_000,
				updatedAt: NOW,
			});
		});
		// The global slice is infrastructure-wide and read stream-lessly, so this
		// per-stream `all` row is invisible to it and cannot hide the breaker.
		await insertPerStreamRow(t, 'all', 1);

		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		try {
			expect(
				await t.run((ctx) =>
					resolveLastMileRoutePlanFromDb(ctx, 'campaign', {
						to: 'person@gmail.com',
						from: 'sender@example.com',
					})
				)
			).toMatchObject({ route: null, deferralCode: 'GLOBAL_DELIVERY_CIRCUIT_OPEN' });
		} finally {
			vi.useRealTimers();
		}
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
