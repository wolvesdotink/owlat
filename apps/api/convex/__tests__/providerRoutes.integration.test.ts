/**
 * Provider-routes mutation contract tests.
 *
 * The settings UI (apps/web .../delivery/provider-routing.vue) uses the shared
 * `result === undefined ⇒ failure` idiom from `useBackendOperation` to decide
 * whether to fire the success toast and close the confirm dialog. Because a
 * caught throw also resolves to `undefined`, every mutation that idiom guards
 * must resolve to a truthy value on success. These tests lock that contract in
 * for `removeRoute` (regression for the missing-return bug) and `setRoute`.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import { SES_RELAY_PROOF_MAX_AGE_MS } from '@owlat/shared';

const permissionState = vi.hoisted(() => ({ allowed: true }));

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		// `authedQuery`/`authedMutation` floor + the handler's own role check.
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireOrgPermission: vi.fn().mockImplementation(async () => {
			if (!permissionState.allowed) throw new Error('Missing required permission');
			return { userId: 'test-user', role: 'owner' };
		}),
	};
});

vi.mock('../domains/providers/ses', async () => {
	const actual = await vi.importActual<typeof import('../domains/providers/ses')>(
		'../domains/providers/ses'
	);
	return {
		...actual,
		sesProvider: {
			...actual.sesProvider,
			registerDomain: vi.fn().mockResolvedValue({
				dnsRecords: {
					spf: { type: 'TXT', host: '@', value: 'v=spf1 include:amazonses.com ~all' },
					dkim: [{ type: 'CNAME', host: 'one._domainkey', value: 'one.dkim.amazonses.com' }],
					mailFrom: [
						{
							type: 'MX',
							host: 'ses-mail',
							value: 'feedback-smtp.eu-central-1.amazonses.com',
							priority: 10,
						},
					],
				},
				identity: { kind: 'ses', dkimTokens: ['one'], verificationToken: 'proof' },
			}),
		},
	};
});

const allModules = import.meta.glob('../**/*.*s');
const modules = Object.fromEntries(
	Object.entries(allModules).filter(
		([path]) =>
			!path.includes('sesActions') &&
			!path.includes('agentSecurity') &&
			!path.includes('agentContext') &&
			!path.includes('agentClassifier') &&
			!path.includes('agentDrafter') &&
			!path.includes('agentRouter') &&
			!path.includes('agent/walker') &&
			!path.includes('agent/steps/') &&
			!path.includes('knowledgeExtraction') &&
			!path.includes('semanticFileProcessing') &&
			!path.includes('visualizationAgent') &&
			!path.includes('llmProvider')
	)
);

const identity = {
	subject: 'test-user',
	issuer: 'https://test.issuer.com',
	tokenIdentifier: 'https://test.issuer.com|test-user',
};

const singleMtaRoute = {
	messageType: 'campaign' as const,
	strategy: 'single' as const,
	providers: [{ providerType: 'mta', isEnabled: true }],
};

beforeEach(() => {
	permissionState.allowed = true;
	vi.useFakeTimers();
	vi.stubEnv('MTA_API_URL', 'https://mta.test');
	vi.stubEnv('MTA_API_KEY', 'test-key');
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
});

describe('providerRoutes mutation contracts', () => {
	it('setRoute returns a truthy id the UI can use as a success signal', async () => {
		const t = convexTest(schema, modules).withIdentity(identity);

		const id = await t.mutation(api.providerRoutes.setRoute, singleMtaRoute);

		expect(id).toBeTruthy();
	});

	it('keeps a controller-owned strategy through an unrelated edit', async () => {
		// The operator UI never OFFERS `adaptive_mix` — the ramp controller writes
		// it — but a route already carrying it goes back through this mutation on
		// every unrelated save. A validator that did not accept the kind the
		// schema stores would reject that save, and the settings page would
		// silently downgrade the route to a pickable strategy.
		const t = convexTest(schema, modules).withIdentity(identity);

		await t.mutation(api.providerRoutes.setRoute, {
			...singleMtaRoute,
			strategy: 'adaptive_mix' as const,
		});

		const [saved] = await t.query(api.providerRoutes.listRoutes, {});
		expect(saved?.strategy).toBe('adaptive_mix');

		// The unrelated edit: toggle a provider, echoing back the strategy the
		// page read, exactly as the settings form serializes it.
		await t.mutation(api.providerRoutes.setRoute, {
			messageType: 'campaign' as const,
			strategy: 'adaptive_mix' as const,
			providers: [{ providerType: 'mta', isEnabled: false }],
		});

		const [edited] = await t.query(api.providerRoutes.listRoutes, {});
		expect(edited?.strategy).toBe('adaptive_mix');
		expect(edited?.providers.map((provider) => provider.isEnabled)).toEqual([false]);
	});

	it('rejects an unknown retired transport even when the client marks it disabled', async () => {
		const t = convexTest(schema, modules).withIdentity(identity);

		await expect(
			t.mutation(api.providerRoutes.setRoute, {
				...singleMtaRoute,
				providers: [
					{ providerType: 'mta', isEnabled: true },
					{ providerType: 'plugin.retired-mail.postmark', isEnabled: false },
				],
			})
		).rejects.toThrow('Provider route contains an unknown transport');
	});

	/**
	 * THE PERSISTENCE GATE AND THE ROUTING GATE ARE ONE PREDICATE (plan D6).
	 *
	 * The shipped check here was `relayProviderType !== 'ses'` — a capability
	 * question answered with a list of one. `resolveRoute` was widened to
	 * `isFallbackRelayEligible` (configured, and not our own MTA), so this
	 * mutation now asks exactly that, and these cases are the four corners of it:
	 * a configured relay is accepted, an UNCONFIGURED one is not (a relay with no
	 * credentials is a second outage, not a fallback), the owned MTA is never a
	 * fallback FOR itself, and an unknown kind still fails closed.
	 */
	it('accepts a configured non-SES relay — the migration shape from the plan', async () => {
		vi.stubEnv('MANDRILL_API_KEY', 'md-test-key');
		const t = convexTest(schema, modules).withIdentity(identity);

		const routeId = await t.mutation(api.providerRoutes.setRoute, {
			...singleMtaRoute,
			strategy: 'adaptive_mix' as const,
			providers: [
				{ providerType: 'mta', isEnabled: true },
				{ providerType: 'mandrill', isEnabled: true },
			],
			deliverabilityFallback: {
				isEnabled: true,
				relayProviderType: 'mandrill',
				isWarmupOverflowEnabled: true,
			},
		});

		expect(routeId).toBeTruthy();
		const [saved] = await t.query(api.providerRoutes.listRoutes, {});
		expect(saved?.deliverabilityFallback).toEqual({
			isEnabled: true,
			relayProviderType: 'mandrill',
			isWarmupOverflowEnabled: true,
		});
	});

	it('rejects an UNCONFIGURED relay and never persists it', async () => {
		// `RESEND_API_KEY` is absent, so the kind is known and non-MTA but has no
		// credentials. Before D6 this was refused for being "not SES"; now it is
		// refused for the reason routing would refuse it at dispatch.
		const t = convexTest(schema, modules).withIdentity(identity);

		await expect(
			t.mutation(api.providerRoutes.setRoute, {
				...singleMtaRoute,
				providers: [
					{ providerType: 'mta', isEnabled: true },
					{ providerType: 'resend', isEnabled: false },
				],
				deliverabilityFallback: {
					isEnabled: true,
					relayProviderType: 'resend',
					isWarmupOverflowEnabled: true,
				},
			})
		).rejects.toThrow('Deliverability fallback relay must be a configured non-MTA transport');

		expect(await t.query(api.providerRoutes.listRoutes, {})).toHaveLength(0);
	});

	it('refuses the owned MTA as its own fallback relay, and an unknown kind', async () => {
		const t = convexTest(schema, modules).withIdentity(identity);

		// The MTA is the arm a fallback moves traffic AWAY from — relieving a
		// reputation problem through the transport that has it is not a fallback.
		// It is configured (MTA_API_URL/KEY are stubbed above), so only the
		// non-MTA half of the predicate can be rejecting it.
		await expect(
			t.mutation(api.providerRoutes.setRoute, {
				...singleMtaRoute,
				deliverabilityFallback: {
					isEnabled: true,
					relayProviderType: 'mta',
					isWarmupOverflowEnabled: false,
				},
			})
		).rejects.toThrow('Deliverability fallback relay must be a configured non-MTA transport');

		await expect(
			t.mutation(api.providerRoutes.setRoute, {
				...singleMtaRoute,
				deliverabilityFallback: {
					isEnabled: true,
					relayProviderType: 'plugin.retired-mail.postmark',
					isWarmupOverflowEnabled: false,
				},
			})
		).rejects.toThrow('Deliverability fallback relay must be a configured non-MTA transport');

		expect(await t.query(api.providerRoutes.listRoutes, {})).toHaveLength(0);
	});

	it('removeRoute returns a truthy value after deleting an existing route', async () => {
		const t = convexTest(schema, modules).withIdentity(identity);
		await t.mutation(api.providerRoutes.setRoute, singleMtaRoute);

		const result = await t.mutation(api.providerRoutes.removeRoute, {
			messageType: 'campaign',
		});

		// Regression: the handler used to resolve to `undefined`, which the
		// settings page reads as a failure (same as a caught throw) — so the
		// reset toast never fired and the confirm dialog stayed open.
		expect(result).not.toBeUndefined();
		expect(result).toEqual({ success: true });

		const remaining = await t.query(api.providerRoutes.listRoutes, {});
		expect(remaining).toHaveLength(0);
	});

	it('removeRoute returns a truthy value even when there is no route to remove', async () => {
		const t = convexTest(schema, modules).withIdentity(identity);

		const result = await t.mutation(api.providerRoutes.removeRoute, {
			messageType: 'transactional',
		});

		// A no-op delete (nothing configured) is still a successful reset.
		expect(result).toEqual({ success: true });
	});
});

describe('providerRoutes.listIpPools', () => {
	it('returns the canonical MTA IP-pool names the routing UI autocompletes', async () => {
		const t = convexTest(schema, modules).withIdentity(identity);

		const pools = await t.query(api.providerRoutes.listIpPools, {});

		// These names come from MTA_IP_POOL_NAMES (the SSOT for MtaExtras.ipPool).
		// The settings UI warns on anything outside this set.
		expect(pools).toEqual(['transactional', 'campaign']);
	});
});

describe('deliverability relay domain lifecycle', () => {
	it('drains verified MTA domains in a cursor batch and schedules continuation', async () => {
		const t = convexTest(schema, modules).withIdentity(identity);
		await t.run(async (ctx) => {
			for (let index = 0; index < 40; index++) {
				await ctx.db.insert('domains', {
					domain: `relay-${index}.example`,
					providerType: 'mta',
					status: 'verified',
					dnsRecords: {},
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
			}
		});

		await t.mutation(internal.providerRoutes.provisionDeliverabilityRelayBatch, {
			paginationOpts: { cursor: null, numItems: 32 },
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const identities = await t.run(
			async (ctx) => await ctx.db.query('sendingDomainSesIdentities').collect()
		);
		expect(identities).toHaveLength(40);
	});

	it('exposes exact SES DNS and verification state to the admin UI query', async () => {
		const t = convexTest(schema, modules).withIdentity(identity);
		await t.run(async (ctx) => {
			const domainId = await ctx.db.insert('domains', {
				domain: 'relay.example',
				providerType: 'mta',
				status: 'verified',
				dnsRecords: {},
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('sendingDomainSesIdentities', {
				domainId,
				dkimTokens: ['one'],
				verificationToken: 'proof',
				dnsRecords: {
					spf: { type: 'TXT', host: '@', value: 'v=spf1 include:amazonses.com ~all' },
				},
				isProviderVerified: false,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const result = await t.query(api.providerRoutes.listDeliverabilityRelayDomains, {
			paginationOpts: { cursor: null, numItems: 100 },
		});
		expect(result.isDone).toBe(true);
		expect(result.page).toMatchObject([
			{
				domain: 'relay.example',
				status: 'pending',
				isProviderVerified: false,
				dnsRecords: { spf: { host: '@' } },
			},
		]);
	});

	it('distinguishes primary verification and paginates beyond 512 domains', async () => {
		const t = convexTest(schema, modules).withIdentity(identity);
		await t.run(async (ctx) => {
			await ctx.db.insert('domains', {
				domain: 'external.example',
				providerType: 'ses',
				status: 'verified',
				dnsRecords: {},
				createdAt: 0,
				updatedAt: 0,
			});
			for (let index = 0; index < 513; index++) {
				await ctx.db.insert('domains', {
					domain: `owned-${index}.example`,
					providerType: 'mta',
					status: index === 0 ? 'pending' : 'verified',
					dnsRecords: {},
					createdAt: index + 1,
					updatedAt: index + 1,
				});
			}
		});

		const first = await t.query(api.providerRoutes.listDeliverabilityRelayDomains, {
			paginationOpts: { cursor: null, numItems: 512 },
		});
		expect(first.isDone).toBe(false);
		const second = await t.query(api.providerRoutes.listDeliverabilityRelayDomains, {
			paginationOpts: { cursor: first.continueCursor, numItems: 512 },
		});
		const domains = [...first.page, ...second.page];
		expect(second.isDone).toBe(true);
		expect(domains).toHaveLength(513);
		expect(domains.some((domain) => domain.domain === 'external.example')).toBe(false);
		expect(domains).toContainEqual(
			expect.objectContaining({
				domain: 'owned-0.example',
				status: 'awaiting_primary_verification',
			})
		);
	});

	it('surfaces an expired SES verification proof as stale', async () => {
		const t = convexTest(schema, modules).withIdentity(identity);
		await t.run(async (ctx) => {
			const domainId = await ctx.db.insert('domains', {
				domain: 'stale-relay.example',
				providerType: 'mta',
				status: 'verified',
				dnsRecords: {},
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('sendingDomainSesIdentities', {
				domainId,
				dkimTokens: ['one'],
				verificationToken: 'proof',
				dnsRecords: {},
				isProviderVerified: true,
				verifiedAt: Date.now() - SES_RELAY_PROOF_MAX_AGE_MS - 1,
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});
		const result = await t.query(api.providerRoutes.listDeliverabilityRelayDomains, {
			paginationOpts: { cursor: null, numItems: 10 },
		});
		expect(result.page[0]?.status).toBe('stale');
	});

	it('keeps operational relay DNS and status behind organization management permission', async () => {
		const t = convexTest(schema, modules).withIdentity(identity);
		permissionState.allowed = false;

		await expect(
			t.query(api.providerRoutes.listDeliverabilityRelayDomains, {
				paginationOpts: { cursor: null, numItems: 100 },
			})
		).rejects.toThrow('Missing required permission');
	});

	it('provisions a future MTA domain on its first verified lifecycle edge', async () => {
		const t = convexTest(schema, modules).withIdentity(identity);
		const domainId = await t.run(async (ctx) => {
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
					isWarmupOverflowEnabled: true,
				},
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			return await ctx.db.insert('domains', {
				domain: 'future-relay.example',
				providerType: 'mta',
				status: 'pending',
				dnsRecords: {},
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		await t.mutation(internal.domains.lifecycle.transition, {
			domainId,
			input: {
				to: 'verified',
				at: Date.now(),
				verificationResults: {
					dkim: [{ verified: true, lastChecked: Date.now() }],
					dmarc: { verified: true, lastChecked: Date.now() },
				},
			},
			userId: 'system:test',
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const relayIdentity = await t.run(
			async (ctx) =>
				await ctx.db
					.query('sendingDomainSesIdentities')
					.withIndex('by_domain', (q) => q.eq('domainId', domainId))
					.first()
		);
		expect(relayIdentity?.verificationToken).toBe('proof');
	});
});
