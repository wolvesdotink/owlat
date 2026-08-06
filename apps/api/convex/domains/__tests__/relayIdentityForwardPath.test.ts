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
 * A second mock kind that registers an adapter with NO `ensureRelayIdentity` —
 * the honest shape of a `domainVerification: 'none'` relay (our own MTA, Resend,
 * a bring-your-own SMTP relay), which has no identity API to register at. The
 * walk must do nothing at all for it rather than fall back to some other kind's
 * provisioning.
 */
const MOCK_IDENTITYLESS_KIND = 'mock-identityless';

const { ensureMockRelayIdentity } = vi.hoisted(() => ({
	ensureMockRelayIdentity: vi.fn(async () => {}),
}));

vi.mock('../providers', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../providers')>();
	const mockRelayProvider = {
		kind: MOCK_RELAY_KIND,
		ensureRelayIdentity: ensureMockRelayIdentity,
	};
	const identitylessProvider = { kind: MOCK_IDENTITYLESS_KIND };
	const overrides: Record<string, unknown> = {
		[MOCK_RELAY_KIND]: mockRelayProvider,
		[MOCK_IDENTITYLESS_KIND]: identitylessProvider,
	};
	return {
		...actual,
		isSendingDomainProviderKind: (kind: string | undefined | null) =>
			(typeof kind === 'string' && Object.prototype.hasOwnProperty.call(overrides, kind)) ||
			actual.isSendingDomainProviderKind(kind),
		providerFor: (kind: string) =>
			Object.prototype.hasOwnProperty.call(overrides, kind)
				? overrides[kind]
				: actual.providerFor(kind as Parameters<typeof actual.providerFor>[0]),
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
		// configured relay kind through `providerFor` and asks THAT module for its
		// backfill.
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
		// the walk as an unknown, and `providerFor` throws on those. Fail closed by
		// skipping, never by rolling back the domain's → verified transition.
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

	it('does not re-register an SES identity the domain already carries', async () => {
		// THE ONE DELIBERATE DELTA of routing this site through the adapter. The
		// if-chain scheduled `sesRelay.provision` unconditionally, so a domain that
		// dropped to `pending` and re-verified was re-registered at SES and had its
		// DKIM tokens (and the DNS records the operator had published) rewritten.
		// `ensureRelayIdentity` owns the "already have one?" check — the drain has
		// asked it since P0.3, and the shipped effect's own comment instructed this
		// conversion — so the two halves now cover every domain EXACTLY once rather
		// than merely at least once. The cost is written out on the adapter method:
		// an identity deleted on the SES side while this row survives is no longer
		// repairable by taking the domain out of `verified` and back.
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

		expect(await scheduledNames(t)).not.toContain('domains/sesRelay:provision');
	});
});
