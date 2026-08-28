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
import { relayDomainVerified } from '../lib/sendProviders/relayDomainVerification';

const permissionState = vi.hoisted(() => ({ allowed: true }));

/** The singleton org every generic relay-identity row is written under. */
const TEST_ORG_ID = 'org-test';

vi.mock('../lib/sessionOrganization', async () => {
	const actual = await vi.importActual('../lib/sessionOrganization');
	return {
		...actual,
		// The generic `sendingDomainRelayIdentities` row is org-scoped, so the
		// relay-identity backfill resolves the singleton org. Nothing in this file
		// stands up a BetterAuth component to answer it from.
		getSingletonOrganizationId: vi.fn().mockResolvedValue('org-test'),
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

// The Mandrill relay's one network call, answered with a fully verified domain
// so the backfill's write is observable. `checkSenderDomain` keeps its real
// implementation — nothing here reaches it.
vi.mock('../domains/providers/mandrill/api', async () => {
	const actual = await vi.importActual<typeof import('../domains/providers/mandrill/api')>(
		'../domains/providers/mandrill/api'
	);
	return {
		...actual,
		addSenderDomain: vi.fn(async (domain: string) => ({
			outcome: 'ok' as const,
			state: {
				domain,
				spf: { isValid: true },
				dkim: { isValid: true },
				isValidSigning: true,
				verifiedAt: Date.now(),
			},
		})),
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

	it('requires the arm the fallback moves traffic away from to be enabled', async () => {
		// The own-MTA precondition (D3's one sanctioned identity). A fallback is
		// traffic leaving OUR infrastructure for a relay, so a route that carries
		// no enabled own-MTA arm has nothing to fall back FROM — the relay would
		// simply be the route. Present-but-disabled is the interesting shape: the
		// operator toggled the arm off and left the fallback configured.
		vi.stubEnv('MANDRILL_API_KEY', 'md-test-key');
		const t = convexTest(schema, modules).withIdentity(identity);

		const fallbackToMandrill = {
			isEnabled: true,
			relayProviderType: 'mandrill',
			isWarmupOverflowEnabled: false,
		};

		await expect(
			t.mutation(api.providerRoutes.setRoute, {
				...singleMtaRoute,
				providers: [
					{ providerType: 'mta', isEnabled: false },
					{ providerType: 'mandrill', isEnabled: true },
				],
				deliverabilityFallback: fallbackToMandrill,
			})
		).rejects.toThrow('Deliverability fallback requires an enabled owned-MTA route');
		expect(await t.query(api.providerRoutes.listRoutes, {})).toHaveLength(0);

		// …and the same route saves the moment that arm is enabled.
		await expect(
			t.mutation(api.providerRoutes.setRoute, {
				...singleMtaRoute,
				providers: [
					{ providerType: 'mta', isEnabled: true },
					{ providerType: 'mandrill', isEnabled: true },
				],
				deliverabilityFallback: fallbackToMandrill,
			})
		).resolves.toBeTruthy();
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

describe('providerRoutes.listRoutes — admin gate', () => {
	it('returns configured routes for an admin (organization:manage)', async () => {
		const t = convexTest(schema, modules).withIdentity(identity);
		await t.run((ctx) =>
			ctx.db.insert('providerRoutes', {
				messageType: 'campaign',
				strategy: 'single',
				providers: [{ providerType: 'mta', isEnabled: true }],
				ipPool: 'campaign',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			})
		);

		const routes = await t.query(api.providerRoutes.listRoutes, {});
		expect(routes).toHaveLength(1);
		expect(routes[0]!.ipPool).toBe('campaign');
	});

	it('rejects a member without organization:manage (transport topology is admin-only)', async () => {
		const t = convexTest(schema, modules).withIdentity(identity);
		await t.run((ctx) =>
			ctx.db.insert('providerRoutes', {
				messageType: 'campaign',
				strategy: 'single',
				providers: [{ providerType: 'mta', isEnabled: true, weight: 100 }],
				ipPool: 'campaign',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			})
		);

		permissionState.allowed = false;
		await expect(t.query(api.providerRoutes.listRoutes, {})).rejects.toThrow();
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

		// `relayProviderType` is the drain's subject, not decoration: the batch
		// backfills the identity of the kind the ROUTE named. SES is what this
		// case has always exercised, and its outcome is unchanged.
		await t.mutation(internal.providerRoutes.provisionDeliverabilityRelayBatch, {
			relayProviderType: 'ses',
			paginationOpts: { cursor: null, numItems: 32 },
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		const identities = await t.run(
			async (ctx) => await ctx.db.query('sendingDomainSesIdentities').collect()
		);
		expect(identities).toHaveLength(40);
	});

	it('backfills nothing for a relay kind with no identity API (P0.2)', async () => {
		// The gate that used to keep this honest was `relayProviderType !== 'ses'`
		// in `setRoute`. Once fallback became a CAPABILITY question, a `resend` or
		// `smtp` route saves — and the drain, still naming SES inline, would have
		// registered SES identities for every MTA domain of a deployment that may
		// hold no AWS credentials at all, then told the operator to publish
		// `amazonses.com` DNS for a provider they never chose.
		const t = convexTest(schema, modules).withIdentity(identity);
		await t.run(async (ctx) => {
			await ctx.db.insert('domains', {
				domain: 'relay.example',
				providerType: 'mta',
				status: 'verified',
				dnsRecords: {},
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		for (const relayProviderType of ['resend', 'smtp', 'mta', 'plugin.retired.postmark', '']) {
			await t.mutation(internal.providerRoutes.provisionDeliverabilityRelayBatch, {
				relayProviderType,
				paginationOpts: { cursor: null, numItems: 32 },
			});
		}
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		// BOTH identity stores, not just SES's. "Backfills nothing" is a claim
		// about every destination the drain can write to, and the generic
		// `sendingDomainRelayIdentities` row is where every kind after SES (D7)
		// lands — a future `domainVerification: 'none'` kind that kept an
		// `ensureRelayIdentity` would write THERE, and a SES-only assertion would
		// stay green through exactly the regression this case exists to catch.
		const { relayIdentities, sesIdentities } = await t.run(async (ctx) => ({
			relayIdentities: await ctx.db.query('sendingDomainRelayIdentities').collect(),
			sesIdentities: await ctx.db.query('sendingDomainSesIdentities').collect(),
		}));
		expect(sesIdentities).toEqual([]);
		expect(relayIdentities).toEqual([]);
	});

	it('saves a relay with no identity API, which then never clears the proof gate', async () => {
		// THE TWO HALVES COMPOSED. Eligibility and the domain proof are pinned
		// separately elsewhere — `resend` is eligible; an unverifiable relay is
		// refused — and each looks right on its own. Together they describe a
		// configuration an operator can save and can never make work: `resend`
		// declares `domainVerification: 'none'`, so it registers no sending-domain
		// provider, so the drain writes nothing (correctly — there is nothing to
		// register at) and `relayDomainVerified` answers false for every domain,
		// forever. When the breaker opens, every affected send is refused with
		// DELIVERABILITY_RELAY_DOMAIN_UNVERIFIED and an instruction to verify the
		// domain for the relay, which for this kind there is no way to satisfy.
		//
		// Pinned as the SHIPPED behaviour, not endorsed: making the refusal say so
		// at save time is a copy-and-catalog change (which kinds may be offered as
		// a fallback at all), and wave 0 may not change what an operator sees. This
		// is the case that fails the day that rule changes.
		vi.stubEnv('RESEND_API_KEY', 're_test_key');
		const t = convexTest(schema, modules).withIdentity(identity);
		await t.run(async (ctx) => {
			await ctx.db.insert('domains', {
				domain: 'relay.example',
				providerType: 'mta',
				status: 'verified',
				dnsRecords: {},
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		await expect(
			t.mutation(api.providerRoutes.setRoute, {
				...singleMtaRoute,
				providers: [
					{ providerType: 'mta', isEnabled: true },
					{ providerType: 'resend', isEnabled: true },
				],
				deliverabilityFallback: {
					isEnabled: true,
					relayProviderType: 'resend',
					isWarmupOverflowEnabled: false,
				},
			})
		).resolves.toBeTruthy();
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const { relayIdentities, sesIdentities, isVerified } = await t.run(async (ctx) => ({
			relayIdentities: await ctx.db.query('sendingDomainRelayIdentities').collect(),
			sesIdentities: await ctx.db.query('sendingDomainSesIdentities').collect(),
			isVerified: await relayDomainVerified(ctx, 'relay.example', 'resend', Date.now()),
		}));
		expect(relayIdentities).toEqual([]);
		expect(sesIdentities).toEqual([]);
		expect(isVerified).toBe(false);
	});

	it('resolves the relay from the stored routes when the batch names none (P0.2)', async () => {
		// THE MIGRATION WINDOW. Convex persists a scheduled function's arguments,
		// so a continuation this drain queued for itself before `relayProviderType`
		// existed arrives without one. Rejecting it would abandon the drain at its
		// cursor — every domain past that point keeps no relay identity, the
		// lifecycle's forward path only covers domains verified LATER, and the
		// operator sees it as a refusal to relay long afterwards. So absent means
		// "whichever relay the routes name", read from the same rows the forward
		// path reads.
		const t = convexTest(schema, modules).withIdentity(identity);
		await t.run(async (ctx) => {
			await ctx.db.insert('domains', {
				domain: 'relay.example',
				providerType: 'mta',
				status: 'verified',
				dnsRecords: {},
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		// No route configured yet: nothing to resolve, and nothing written.
		await t.mutation(internal.providerRoutes.provisionDeliverabilityRelayBatch, {
			paginationOpts: { cursor: null, numItems: 32 },
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);
		expect(
			await t.run(async (ctx) => await ctx.db.query('sendingDomainRelayIdentities').collect())
		).toEqual([]);

		await t.run(async (ctx) => {
			await ctx.db.insert('providerRoutes', {
				messageType: 'campaign',
				strategy: 'single',
				providers: [
					{ providerType: 'mta', isEnabled: true },
					{ providerType: 'mandrill', isEnabled: true },
				],
				deliverabilityFallback: {
					isEnabled: true,
					relayProviderType: 'mandrill',
					isWarmupOverflowEnabled: false,
				},
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		await t.mutation(internal.providerRoutes.provisionDeliverabilityRelayBatch, {
			paginationOpts: { cursor: null, numItems: 32 },
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const { relayIdentities, sesIdentities } = await t.run(async (ctx) => ({
			relayIdentities: await ctx.db.query('sendingDomainRelayIdentities').collect(),
			sesIdentities: await ctx.db.query('sendingDomainSesIdentities').collect(),
		}));
		// The kind came from the ROUTE, not from a default — a drain that fell back
		// to SES here is precisely the pre-P0.2 behaviour this piece removed.
		expect(sesIdentities).toEqual([]);
		expect(relayIdentities).toHaveLength(1);
		expect(relayIdentities[0]).toMatchObject({ providerKind: 'mandrill' });
	});

	it('backfills the relay kind the route named, through its own provider (P0.2)', async () => {
		// The positive half of the same claim: Mandrill declares
		// `domainVerification: 'api'` and registers a sending-domain provider, so
		// the SAME drain backfills ITS identity — into the generic
		// `sendingDomainRelayIdentities` row (D7), with no SES identity written at
		// all. Nothing in `providerRoutes.ts` names either kind.
		const t = convexTest(schema, modules).withIdentity(identity);
		await t.run(async (ctx) => {
			await ctx.db.insert('domains', {
				domain: 'relay.example',
				providerType: 'mta',
				status: 'verified',
				dnsRecords: {},
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		await t.mutation(internal.providerRoutes.provisionDeliverabilityRelayBatch, {
			relayProviderType: 'mandrill',
			paginationOpts: { cursor: null, numItems: 32 },
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const { relayIdentities, sesIdentities } = await t.run(async (ctx) => ({
			relayIdentities: await ctx.db.query('sendingDomainRelayIdentities').collect(),
			sesIdentities: await ctx.db.query('sendingDomainSesIdentities').collect(),
		}));
		expect(sesIdentities).toEqual([]);
		expect(relayIdentities).toHaveLength(1);
		expect(relayIdentities[0]).toMatchObject({
			domain: 'relay.example',
			providerKind: 'mandrill',
			status: 'verified',
		});
	});

	it.each([
		{
			relayProviderType: 'mandrill',
			table: 'sendingDomainRelayIdentities',
			empty: 'sendingDomainSesIdentities',
		},
		{
			relayProviderType: 'ses',
			table: 'sendingDomainSesIdentities',
			empty: 'sendingDomainRelayIdentities',
		},
	] as const)(
		'setRoute drains the relay the ROUTE named — $relayProviderType (P0.2)',
		async ({ relayProviderType, table, empty }) => {
			// THE WIRE ITSELF. Every other drain case above calls the batch mutation
			// with a hand-supplied kind, which proves the drain honours its argument
			// but not that `setRoute` passes the RIGHT one. Pin the whole path — an
			// operator saves a fallback, the scheduled backfill runs — because a
			// literal in that one `runAfter` call would leave a Mandrill deployment
			// registering SES identities against an AWS account it may not have, and
			// nothing else in this suite would notice.
			vi.stubEnv('MANDRILL_API_KEY', 'md-test-key');
			vi.stubEnv('AWS_SES_REGION', 'eu-central-1');
			vi.stubEnv('AWS_SES_ACCESS_KEY_ID', 'aws-test-key');
			vi.stubEnv('AWS_SES_SECRET_ACCESS_KEY', 'aws-test-secret');
			const t = convexTest(schema, modules).withIdentity(identity);
			await t.run(async (ctx) => {
				await ctx.db.insert('domains', {
					domain: 'relay.example',
					providerType: 'mta',
					status: 'verified',
					dnsRecords: {},
					createdAt: Date.now(),
					updatedAt: Date.now(),
				});
			});

			await t.mutation(api.providerRoutes.setRoute, {
				...singleMtaRoute,
				providers: [
					{ providerType: 'mta', isEnabled: true },
					{ providerType: relayProviderType, isEnabled: true },
				],
				deliverabilityFallback: {
					isEnabled: true,
					relayProviderType,
					isWarmupOverflowEnabled: false,
				},
			});
			await t.finishAllScheduledFunctions(vi.runAllTimers);

			const { provisioned, untouched } = await t.run(async (ctx) => ({
				provisioned: await ctx.db.query(table).collect(),
				untouched: await ctx.db.query(empty).collect(),
			}));
			expect(provisioned).toHaveLength(1);
			// The other kind's identity store is not merely absent from the route —
			// it was never written to.
			expect(untouched).toEqual([]);
		}
	);

	it('does not re-provision a domain that already holds the relay identity', async () => {
		// The existence check belongs to the PROVIDER now (each kind knows where
		// its identity lives); this pins that moving it did not lose it, for both
		// registered kinds.
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
				dkimTokens: ['already-here'],
				verificationToken: 'already-here',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('sendingDomainRelayIdentities', {
				organizationId: TEST_ORG_ID,
				domain: 'relay.example',
				providerKind: 'mandrill',
				status: 'pending_dns',
				spf: { isValid: false },
				dkim: { isValid: false },
				lastCheckedAt: Date.now(),
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		for (const relayProviderType of ['ses', 'mandrill']) {
			await t.mutation(internal.providerRoutes.provisionDeliverabilityRelayBatch, {
				relayProviderType,
				paginationOpts: { cursor: null, numItems: 32 },
			});
		}
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const { relayIdentities, sesIdentities } = await t.run(async (ctx) => ({
			relayIdentities: await ctx.db.query('sendingDomainRelayIdentities').collect(),
			sesIdentities: await ctx.db.query('sendingDomainSesIdentities').collect(),
		}));
		expect(sesIdentities).toHaveLength(1);
		expect(sesIdentities[0]?.verificationToken).toBe('already-here');
		expect(relayIdentities).toHaveLength(1);
		expect(relayIdentities[0]?.status).toBe('pending_dns');
	});

	it('matches an existing relay identity for a domain stored with mixed case', async () => {
		// The generic `sendingDomainRelayIdentities` table keys on the LOWERCASED
		// name (every writer in `mandrill/persistence.ts` normalises), while the
		// `domains` row it is keyed from is normalised only by `domains.create` —
		// the seed loader and any future writer can put mixed case in the table.
		// The drain hands the provider the doc rather than re-resolving the name,
		// so the normalisation the round-trip used to supply has to be done at the
		// existence read or every drain page re-provisions the domain.
		const t = convexTest(schema, modules).withIdentity(identity);
		await t.run(async (ctx) => {
			await ctx.db.insert('domains', {
				domain: 'Relay.Example',
				providerType: 'mta',
				status: 'verified',
				dnsRecords: {},
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('sendingDomainRelayIdentities', {
				organizationId: TEST_ORG_ID,
				domain: 'relay.example',
				providerKind: 'mandrill',
				status: 'pending_dns',
				spf: { isValid: false },
				dkim: { isValid: false },
				lastCheckedAt: Date.now(),
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		await t.mutation(internal.providerRoutes.provisionDeliverabilityRelayBatch, {
			relayProviderType: 'mandrill',
			paginationOpts: { cursor: null, numItems: 32 },
		});
		await t.finishAllScheduledFunctions(vi.runAllTimers);

		const relayIdentities = await t.run(
			async (ctx) => await ctx.db.query('sendingDomainRelayIdentities').collect()
		);
		// One row, still the operator-visible pending verdict: a re-provision would
		// have called `senders/add-domain` again and overwritten it with `verified`.
		expect(relayIdentities).toHaveLength(1);
		expect(relayIdentities[0]?.status).toBe('pending_dns');
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

		const result = await t.query(api.providerRoutes.listRelayDomainIdentities, {
			paginationOpts: { cursor: null, numItems: 100 },
		});
		expect(result.isDone).toBe(true);
		// The SES sibling's remembered bundle, flattened into the one row shape
		// every relay kind answers in — and NAMED from the catalog, not from a
		// literal in the query or in the panel above it.
		expect(result.page).toMatchObject([
			{
				domain: 'relay.example',
				kind: 'ses',
				kindLabel: 'Amazon SES',
				status: 'pending',
				records: [{ label: 'SPF', type: 'TXT', host: '@' }],
			},
		]);
	});

	it('reports a non-SES relay identity from the generic table, with its own records', async () => {
		// THE DIVERGENCE THIS INVERTS. Until the read walked the registry, the
		// query point-read `sendingDomainSesIdentities` and shaped its row around
		// SES's bundle, so a deployment whose fallback relay is Mandrill relayed
		// correctly (the drain above proves the identity is written) while this
		// query — the entire content of `RelayDomainStatus.vue` — answered
		// `provisioning` with no DNS records for every owned-MTA domain, forever.
		// The previous revision of this test asserted that broken behaviour on
		// purpose, so that the fix could not ship without someone inverting it by
		// hand. This is that inversion: `verified`, with the records Mandrill
		// derives, under the label the catalog gives the kind.
		const t = convexTest(schema, modules).withIdentity(identity);
		await t.run(async (ctx) => {
			await ctx.db.insert('domains', {
				domain: 'relay.example',
				providerType: 'mta',
				status: 'verified',
				dnsRecords: {},
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('sendingDomainRelayIdentities', {
				organizationId: TEST_ORG_ID,
				domain: 'relay.example',
				providerKind: 'mandrill',
				status: 'verified',
				spf: { isValid: true },
				dkim: { isValid: true },
				lastCheckedAt: Date.now(),
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		const result = await t.query(api.providerRoutes.listRelayDomainIdentities, {
			paginationOpts: { cursor: null, numItems: 100 },
		});
		expect(result.page).toMatchObject([
			{
				domain: 'relay.example',
				kind: 'mandrill',
				kindLabel: 'Mailchimp Transactional (Mandrill)',
				status: 'verified',
				// Derived from the domain name by the same helper the adapter
				// registers with — Mandrill remembers no per-domain records.
				records: [
					{ label: 'SPF', value: 'v=spf1 include:spf.mandrillapp.com -all' },
					{ label: 'DKIM', host: 'mandrill._domainkey' },
				],
			},
		]);
		// Ownership is Mandrill's own ceremony and this row has never cleared it —
		// the state that makes it bounce mail with `reject_reason: unsigned`
		// however good the DNS is.
		expect(result.page[0]?.isOwnershipVerified).toBe(false);
	});

	it('distinguishes primary verification and paginates beyond 512 domains', async () => {
		const t = convexTest(schema, modules).withIdentity(identity);
		await t.run(async (ctx) => {
			// A CONFIGURED escape hatch, with no identity provisioned yet: that is
			// what makes `provisioning` a truthful answer for these domains. Without
			// a configured relay the query answers for none of them, which is the
			// point one test down.
			await ctx.db.insert('providerRoutes', {
				messageType: 'campaign',
				strategy: 'single',
				providers: [{ providerType: 'mta', isEnabled: true }],
				deliverabilityFallback: {
					isEnabled: false,
					relayProviderType: 'ses',
					isWarmupOverflowEnabled: false,
				},
				createdAt: 0,
				updatedAt: 0,
			});
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

		const first = await t.query(api.providerRoutes.listRelayDomainIdentities, {
			paginationOpts: { cursor: null, numItems: 512 },
		});
		expect(first.isDone).toBe(false);
		const second = await t.query(api.providerRoutes.listRelayDomainIdentities, {
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

	it('answers for no kind at all when this deployment has configured no relay', async () => {
		// THE SHIPPED BUG, ONE LAYER DOWN. The query used to answer for every owned
		// sending domain whatever the deployment had configured, and the panel
		// filtered the result in the browser — so the gate could never be more
		// truthful than the rows behind it. A Resend, SMTP or own-MTA-only
		// deployment now gets an empty page rather than a provisioning run that
		// will never start.
		const t = convexTest(schema, modules).withIdentity(identity);
		await t.run(async (ctx) => {
			await ctx.db.insert('domains', {
				domain: 'owned.example',
				providerType: 'mta',
				status: 'verified',
				dnsRecords: {},
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});
		const result = await t.query(api.providerRoutes.listRelayDomainIdentities, {
			paginationOpts: { cursor: null, numItems: 10 },
		});
		expect(result.page).toEqual([]);
	});

	it('dates an SES proof from its verification, under the bound routing applies', async () => {
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
		const result = await t.query(api.providerRoutes.listRelayDomainIdentities, {
			paginationOpts: { cursor: null, numItems: 10 },
		});
		// AGEING MOVED TO THE SURFACE, and the bound moved with it. The query used
		// to return a synthesised `stale`, computed here against SES's constant;
		// the row now carries the evidence date and the SAME bound routing refuses
		// past, so one clock read in the browser ages the proof for every kind
		// (Mandrill's seven days, the plugin tier's, SES's thirty) instead of one
		// backend rule per vendor. A page left open catches up on the next tick
		// rather than on the next write.
		expect(result.page[0]).toMatchObject({
			kind: 'ses',
			status: 'verified',
			proofMaxAgeMs: SES_RELAY_PROOF_MAX_AGE_MS,
		});
		expect(result.page[0]?.lastCheckedAt).toBeLessThan(Date.now() - SES_RELAY_PROOF_MAX_AGE_MS);
	});

	it('keeps operational relay DNS and status behind organization management permission', async () => {
		const t = convexTest(schema, modules).withIdentity(identity);
		permissionState.allowed = false;

		await expect(
			t.query(api.providerRoutes.listRelayDomainIdentities, {
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
