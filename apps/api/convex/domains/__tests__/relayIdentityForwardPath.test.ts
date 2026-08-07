/**
 * THE FORWARD RELAY-IDENTITY PATH IS A REGISTRY WALK (the seams plan's P0.4).
 *
 * A domain reaching `verified` whose PRIMARY provider is our own MTA also gets a
 * coexisting identity at whatever relay the deliverability fallback names, so
 * that the relay can be handed that From domain the moment the breaker opens.
 * The effect that does it used to be a hand-written pair of ifs —
 * `relayKinds.has('ses')` / `relayKinds.has('mandrill')` — which is a list, not
 * a capability: a newly registered `domainVerification: 'api'` kind got the
 * catch-up drain (`providerRoutes.provisionDeliverabilityRelayBatch`, already a
 * registry walk since P0.2) and NOT this half, so its domains verified, silently
 * received no relay identity, and its fallback then refused to relay them — with
 * the only symptom a runtime refusal on a real send.
 *
 * The gate is therefore differential in the one direction that matters: the
 * MOCK-KIND cases below register a relay kind neither literal ever named, and
 * they are unsatisfiable by any if-chain over the shipped kinds. The `ses` and
 * `mandrill` cases pin that the two the if-chain DID name are unchanged.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { internal } from '../../_generated/api';
import type { Doc, Id } from '../../_generated/dataModel';
import { modules } from '../../__tests__/testModules';

/**
 * The singleton-organization read the Mandrill adapter's `ensureRelayIdentity`
 * makes before deciding whether it already holds a row. Stubbed rather than
 * component-registered for the same reason `domains/__tests__/mandrillRelayQueries`
 * stubs it: this suite is about WHICH provider the walk asks, not about
 * BetterAuth's adapter.
 */
vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof import('../../lib/sessionOrganization')>(
		'../../lib/sessionOrganization'
	);
	return { ...actual, getSingletonOrganizationId: vi.fn().mockResolvedValue('org-a') };
});

/**
 * A relay kind that exists nowhere in the tree — not in the send-provider
 * catalog, not in `SENDING_DOMAIN_PROVIDERS`, and above all not in the if-chain
 * this piece deleted. Anything that reaches its `ensureRelayIdentity` did so by
 * ASKING the registry which provider the configured relay kind resolves to.
 */
const MOCK_RELAY_KIND = 'mock-relay';

/**
 * A second mock kind that is a configured relay with NO relay-identity provider —
 * the honest shape of a `domainVerification: 'none'` relay (our own MTA, Resend,
 * a bring-your-own SMTP relay), which has no identity API to register at. The
 * walk must do nothing at all for it rather than fall back to some other kind's
 * provisioning.
 */
const MOCK_IDENTITYLESS_KIND = 'mock-identityless';

const { ensureMockRelayIdentity } = vi.hoisted(() => ({
	ensureMockRelayIdentity: vi.fn(async () => {}),
}));

// The seam the walk asks is `relayIdentityProviderFor` — the COMPOSED
// relay-identity registry (the seams plan's P3.2), which answers for core
// adapters and for bundled plugin transports alike. Overriding it here is the
// same interception this suite has always made, at the accessor the walk now
// uses: `MOCK_RELAY_KIND` resolves to a provider, `MOCK_IDENTITYLESS_KIND`
// resolves to nothing at all (which is what a relay with no identity API looks
// like to the registry — it is filtered out, not registered with a hole).
vi.mock('../providers', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../providers')>();
	const mockRelayProvider = {
		kind: MOCK_RELAY_KIND,
		ensureRelayIdentity: ensureMockRelayIdentity,
	};
	const overrides: Record<string, unknown> = { [MOCK_RELAY_KIND]: mockRelayProvider };
	return {
		...actual,
		relayIdentityProviderFor: (kind: string | undefined | null) =>
			typeof kind === 'string' && Object.prototype.hasOwnProperty.call(overrides, kind)
				? overrides[kind]
				: actual.relayIdentityProviderFor(kind),
	};
});

type TestConvex = ReturnType<typeof convexTest>;

async function seedRoute(t: TestConvex, relayProviderType: string): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('providerRoutes', {
			messageType: 'transactional',
			strategy: 'single',
			providers: [{ providerType: 'mta', isEnabled: true }],
			deliverabilityFallback: {
				isEnabled: true,
				relayProviderType,
				isWarmupOverflowEnabled: false,
			},
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	});
}

async function seedPendingDomain(
	t: TestConvex,
	providerType: string,
	domain = 'forward.example.com'
): Promise<Id<'domains'>> {
	return await t.run(async (ctx) =>
		ctx.db.insert('domains', {
			domain,
			status: 'pending',
			providerType,
			dnsRecords: { dkim: [] },
			createdAt: Date.now(),
			updatedAt: Date.now(),
		})
	);
}

async function verify(t: TestConvex, domainId: Id<'domains'>): Promise<void> {
	const outcome = await t.mutation(internal.domains.lifecycle.transition, {
		domainId,
		input: { to: 'verified', at: Date.now(), verificationResults: {} },
		userId: 'system:test',
	});
	expect(outcome).toMatchObject({ ok: true, to: 'verified' });
}

/** Names of the scheduled functions queued so far, in insertion order. */
async function scheduledNames(t: TestConvex): Promise<string[]> {
	return await t.run(async (ctx) =>
		(await ctx.db.system.query('_scheduled_functions').collect()).map((job) => job.name)
	);
}

beforeEach(() => {
	ensureMockRelayIdentity.mockClear();
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('provision_relay_identity_if_enabled asks the registry, not a list of kinds', () => {
	it('reaches a relay kind neither branch of the deleted if-chain ever named', async () => {
		// THE DIFFERENTIAL CASE. `mock-relay` is not `ses` and not `mandrill`, so
		// the shipped if-chain matched nothing and this expectation was
		// unsatisfiable by it. It passes only because the effect resolves the
		// configured relay kind through the relay-identity registry and asks THAT
		// module for its backfill.
		const t = convexTest(schema, modules);
		await seedRoute(t, MOCK_RELAY_KIND);
		const domainId = await seedPendingDomain(t, 'mta');

		await verify(t, domainId);

		expect(ensureMockRelayIdentity).toHaveBeenCalledTimes(1);
		const [, domain] = ensureMockRelayIdentity.mock.calls[0] as unknown as [
			unknown,
			Doc<'domains'>,
		];
		// The whole doc, as `ensureRelayIdentity`'s contract requires — an adapter
		// keyed on the domain NAME (the generic `sendingDomainRelayIdentities` row)
		// must not have to re-read the row the caller already holds.
		expect({ id: domain._id, name: domain.domain, status: domain.status }).toEqual({
			id: domainId,
			name: 'forward.example.com',
			// Re-read AFTER the status patch, so an adapter that looks at the
			// lifecycle state sees the transition that triggered it.
			status: 'verified',
		});
	});

	it('does nothing for a configured relay whose adapter has no identity to register', async () => {
		// Absence is a real answer, not a gap: a `domainVerification: 'none'` relay
		// has no identity API at all. The walk must skip it rather than provisioning
		// some other kind's identity — the failure this mirrors is the SES drain
		// that used to run for every deployment regardless of the relay it chose.
		const t = convexTest(schema, modules);
		await seedRoute(t, MOCK_IDENTITYLESS_KIND);
		const domainId = await seedPendingDomain(t, 'mta');

		await verify(t, domainId);

		expect(ensureMockRelayIdentity).not.toHaveBeenCalled();
		expect(await scheduledNames(t)).not.toContain('domains/sesRelay:provision');
	});

	it('ignores a stored relay kind no adapter is registered for', async () => {
		// `deliverabilityFallback.relayProviderType` is a plain string on the row:
		// a route written by a newer deployment (or naming a retired kind) reaches
		// the walk as an unknown, and the registry answers `undefined`. Fail closed
		// by skipping, never by rolling back the domain's → verified transition.
		const t = convexTest(schema, modules);
		await seedRoute(t, 'postmark');
		const domainId = await seedPendingDomain(t, 'mta');

		await verify(t, domainId);

		const domain = await t.run(async (ctx) => ctx.db.get(domainId));
		expect(domain?.status).toBe('verified');
		expect(ensureMockRelayIdentity).not.toHaveBeenCalled();
	});

	it('leaves a domain hosted at a provider of its own alone', async () => {
		// D3's one sanctioned identity check, read from the registry's single
		// declaration: a relay identity COEXISTS only on a domain whose primary
		// provider is our own MTA. A domain already hosted at a relay owns its
		// identity through the ordinary lifecycle.
		const t = convexTest(schema, modules);
		await seedRoute(t, MOCK_RELAY_KIND);
		const domainId = await seedPendingDomain(t, 'ses');

		await verify(t, domainId);

		expect(ensureMockRelayIdentity).not.toHaveBeenCalled();
	});

	it('asks every enabled fallback relay, not just the first route', async () => {
		const t = convexTest(schema, modules);
		await seedRoute(t, MOCK_RELAY_KIND);
		await seedRoute(t, MOCK_IDENTITYLESS_KIND);
		await seedRoute(t, MOCK_RELAY_KIND); // deduplicated by kind, not by route
		const domainId = await seedPendingDomain(t, 'mta');

		await verify(t, domainId);

		expect(ensureMockRelayIdentity).toHaveBeenCalledTimes(1);
	});

	it('names the failing relay when an adapter throws, and still lands the transition', async () => {
		// TWO RULES AT ONE SITE. The throw is swallowed because this runs inside the
		// mutation that lands `→ verified`: propagating it would roll the transition
		// back and the operator would see Verify error out with the domain stuck —
		// the failure the "schedule, never call inline" rule exists to prevent,
		// arriving through the read the adapters do before they schedule.
		//
		// But the swallow is the only thing standing between a failed backfill and
		// silence, and with two relays configured — the case the loop exists for —
		// a log line naming only the domain cannot tell an operator WHICH relay to
		// re-provision, while the symptom they are chasing (that relay refusing
		// this From domain once the breaker opens) names neither. So the kind
		// travels bound to the function and lands in the message.
		const t = convexTest(schema, modules);
		await seedRoute(t, MOCK_RELAY_KIND);
		const domainId = await seedPendingDomain(t, 'mta');
		ensureMockRelayIdentity.mockRejectedValueOnce(new Error('provider lookup failed'));
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

		await verify(t, domainId);

		expect(await t.run(async (ctx) => (await ctx.db.get(domainId))?.status)).toBe('verified');
		expect(logged.mock.calls.map(([message]) => String(message))).toContainEqual(
			expect.stringContaining(`${MOCK_RELAY_KIND} backfill failed for forward.example.com`)
		);
		logged.mockRestore();
	});

	it('does nothing when no route has the fallback switched on', async () => {
		const t = convexTest(schema, modules);
		await t.run(async (ctx) => {
			await ctx.db.insert('providerRoutes', {
				messageType: 'transactional',
				strategy: 'single',
				providers: [{ providerType: 'mta', isEnabled: true }],
				deliverabilityFallback: {
					isEnabled: false,
					relayProviderType: MOCK_RELAY_KIND,
					isWarmupOverflowEnabled: false,
				},
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});
		const domainId = await seedPendingDomain(t, 'mta');

		await verify(t, domainId);

		expect(ensureMockRelayIdentity).not.toHaveBeenCalled();
	});
});

describe('the two kinds the if-chain named keep their shipped behaviour', () => {
	it('schedules the SES relay provisioning for an SES fallback', async () => {
		const t = convexTest(schema, modules);
		await seedRoute(t, 'ses');
		const domainId = await seedPendingDomain(t, 'mta');

		await verify(t, domainId);

		const scheduled = await t.run(async (ctx) =>
			(await ctx.db.system.query('_scheduled_functions').collect())
				.filter((job) => job.name.includes('sesRelay'))
				.map((job) => ({ name: job.name, args: job.args[0] }))
		);
		expect(scheduled).toEqual([{ name: 'domains/sesRelay:provision', args: { domainId } }]);
	});

	it('schedules the Mandrill relay provisioning for a Mandrill fallback', async () => {
		const t = convexTest(schema, modules);
		await seedRoute(t, 'mandrill');
		const domainId = await seedPendingDomain(t, 'mta');

		await verify(t, domainId);

		const scheduled = await t.run(async (ctx) =>
			(await ctx.db.system.query('_scheduled_functions').collect())
				.filter((job) => job.name.includes('mandrillRelay'))
				.map((job) => ({ name: job.name, args: job.args[0] }))
		);
		expect(scheduled).toEqual([{ name: 'domains/mandrillRelay:provision', args: { domainId } }]);
	});

	it('re-registers an SES identity the domain already carries — the repair lever', async () => {
		// THE FORWARD PATH RE-REGISTERS; THE DRAIN CONVERGES. Both halves call the
		// same `ensureRelayIdentity` since P0.4, and the thing they do NOT agree on
		// travels with the call (`EnsureRelayIdentityOptions`): the drain walks
		// every verified domain on every page and must skip the ones already done,
		// while this edge fires only on a real `→ verified` transition — which an
		// operator reaches by taking the domain out of `verified` and putting it
		// back.
		//
		// That deliberate act is their ONLY lever for re-registering an identity
		// deleted or disabled on the AWS side while our sibling row survived:
		// nothing in the stored state distinguishes that from "waiting for the
		// CNAMEs", so the drain cannot detect it, and no other surface re-registers.
		// It shipped unconditional and it stays unconditional — a wave the plan
		// requires to be behaviour-neutral is not where a repair path disappears.
		const t = convexTest(schema, modules);
		await seedRoute(t, 'ses');
		const domainId = await seedPendingDomain(t, 'mta');
		await t.run(async (ctx) => {
			await ctx.db.insert('sendingDomainSesIdentities', {
				domainId,
				dkimTokens: ['one', 'two', 'three'],
				verificationToken: 'already-registered',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		await verify(t, domainId);

		expect(await scheduledNames(t)).toContain('domains/sesRelay:provision');
	});

	it('leaves an identity the DRAIN already provisioned alone', async () => {
		// The other side of the same option, asserted through the drain so the two
		// intents are pinned against one implementation rather than one of them
		// being taken on trust from a docblock.
		const t = convexTest(schema, modules);
		await seedRoute(t, 'ses');
		// Seeded straight into `verified` — the drain's own subject. Reaching that
		// state through `verify()` would fire the forward path first, and this case
		// is about the drain alone.
		await t.run(async (ctx) => {
			const id = await ctx.db.insert('domains', {
				domain: 'drained.example.com',
				status: 'verified',
				providerType: 'mta',
				dnsRecords: { dkim: [] },
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
			await ctx.db.insert('sendingDomainSesIdentities', {
				domainId: id,
				dkimTokens: ['one', 'two', 'three'],
				verificationToken: 'already-registered',
				createdAt: Date.now(),
				updatedAt: Date.now(),
			});
		});

		await t.mutation(internal.providerRoutes.provisionDeliverabilityRelayBatch, {
			paginationOpts: { cursor: null, numItems: 10 },
		});

		expect(await scheduledNames(t)).not.toContain('domains/sesRelay:provision');
	});
});
