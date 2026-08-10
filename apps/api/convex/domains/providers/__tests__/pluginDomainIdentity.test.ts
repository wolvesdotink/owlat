/**
 * PLUGIN DOMAIN IDENTITY (the seams plan's P3.2) — the registry, with a fixture
 * plugin identity provider, and `relayDomainVerification` resolving it end to
 * end.
 *
 * This is the piece's hard gate, and it is differential in the direction that
 * matters: `plugin.mail-pack.postmark` is not `ses` and not `mandrill`, it is not
 * a key of `SENDING_DOMAIN_PROVIDERS`, and `isSendingDomainProviderKind` refuses
 * it (deliberately — that guard governs `domains.providerType`, a domain's
 * PRIMARY provider, and widening it would run a domain's whole lifecycle through
 * third-party code). Every expectation below was therefore unsatisfiable before
 * this piece: they pass only because the relay-identity registry is COMPOSED with
 * the bundled plugin tier at build time, and because the rows land in the generic
 * `sendingDomainRelayIdentities` table keyed by the namespaced kind (D10: rows,
 * not columns — no schema changed).
 *
 * The four properties, in order:
 *
 *  1. the registry answers for the plugin kind, and keeps answering `undefined`
 *     for the kinds that legitimately cannot prove a domain;
 *  2. `relayDomainVerified` — the enqueue-path proof — resolves the plugin's row
 *     and applies the HOST's rule to it (status, both records, freshness), with
 *     every way of being incomplete failing closed;
 *  3. `describeReferenceArm` is built only from a proven identity, and only when
 *     the observation recorded DNS the pre-flight could resolve;
 *  4. `ensureRelayIdentity` schedules the provider call rather than making it,
 *     converges for the drain and repeats for the operator's repair lever.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import type { Doc } from '../../../_generated/dataModel';
import type { DatabaseReader } from '../../../_generated/server';

const KIND = 'plugin.mail-pack.postmark';
const PLUGIN_ID = 'mail-pack';
const DOMAIN = 'sender.example.com';
const NOW = 1_800_000_000_000;

/**
 * The generated send catalog must hold the transport, under the same owner: the
 * identity registry refuses at load an identity for a kind that never sends, so
 * a relay could not prove domains for a transport no route can select.
 */
vi.mock('../../../plugins/sendTransportCatalog.generated', () => ({
	BUNDLED_PLUGIN_SEND_TRANSPORT_CATALOG: Object.freeze([
		Object.freeze({
			kind: KIND,
			pluginId: PLUGIN_ID,
			localId: 'postmark',
			label: 'Postmark',
			retryDelays: Object.freeze([0]),
			requiredEnvVars: Object.freeze(['POSTMARK_PACK_ENABLED', 'PLUGIN_POSTMARK_TOKEN']),
			instanceEnvVars: Object.freeze(['PLUGIN_POSTMARK_TOKEN']),
			// DERIVED from the identity declaration, which is what makes this fixture
			// a faithful composition rather than a hand-set flag.
			domainVerification: 'api',
			requiredCapability: 'send:transport',
		}),
	]),
}));

vi.mock('../../../plugins/sendTransportDomainIdentityCatalog.generated', () => ({
	BUNDLED_PLUGIN_SEND_TRANSPORT_DOMAIN_IDENTITY_CATALOG: Object.freeze([
		Object.freeze({
			kind: KIND,
			pluginId: PLUGIN_ID,
			localId: 'postmark',
			label: 'Postmark',
			instanceEnvVars: Object.freeze(['PLUGIN_POSTMARK_TOKEN']),
			requiredEnvVars: Object.freeze(['PLUGIN_POSTMARK_TOKEN']),
			requiredCapability: 'send:transport',
		}),
	]),
}));

vi.mock('../../../plugins/sendTransportDomainIdentityModules.generated', () => ({
	BUNDLED_PLUGIN_SEND_TRANSPORT_DOMAIN_IDENTITY_MODULES: Object.freeze([
		Object.freeze({
			kind: KIND,
			pluginId: PLUGIN_ID,
			module: { registerDomain: async () => ({}), checkDomain: async () => ({}) },
		}),
	]),
}));

/**
 * The singleton-organization read `ensureRelayIdentity` makes before deciding
 * whether it already holds a row. Stubbed for the same reason the forward-path
 * suite stubs it: this file is about WHICH provider answers, not about
 * BetterAuth's adapter.
 */
vi.mock('../../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof import('../../../lib/sessionOrganization')>(
		'../../../lib/sessionOrganization'
	);
	return { ...actual, getSingletonOrganizationId: vi.fn().mockResolvedValue('org-a') };
});

const { SENDING_DOMAIN_PROVIDERS, isSendingDomainProviderKind, relayIdentityProviderFor } =
	await import('../index');
const { relayDomainVerified } = await import('../../../lib/sendProviders/relayDomainVerification');
const { PLUGIN_RELAY_PROOF_MAX_AGE_MS } = await import('../plugin/state');
const { SEND_PROVIDER_CATALOG, domainVerificationFor } =
	await import('../../../lib/sendProviders/catalog');
const schema = (await import('../../../schema')).default;
const { modules } = await import('../../../__tests__/testModules');
const { internal } = await import('../../../_generated/api');

type TestConvex = ReturnType<typeof convexTest>;
type RowOverrides = Partial<{
	providerKind: string;
	status: 'unverified' | 'pending_dns' | 'verified' | 'failed';
	spf: { isValid: boolean };
	dkim: { isValid: boolean };
	providerDetails: string;
	lastCheckedAt: number;
}>;

/** A fresh, fully proven plugin relay identity in the generic table. */
async function seedIdentity(t: TestConvex, overrides: RowOverrides = {}): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('sendingDomainRelayIdentities', {
			organizationId: 'org-a',
			domain: DOMAIN,
			providerKind: KIND,
			status: 'verified',
			spf: { isValid: true },
			dkim: { isValid: true },
			providerDetails: JSON.stringify({
				kind: 'plugin',
				dkimSelectors: ['pm-bounces'],
				spfMechanisms: ['include:spf.postmarkapp.example'],
			}),
			providerDetailsVersion: 1,
			lastCheckedAt: NOW,
			createdAt: NOW,
			updatedAt: NOW,
			...overrides,
		});
	});
}

async function seedDomain(t: TestConvex): Promise<void> {
	await t.run(async (ctx) => {
		await ctx.db.insert('domains', {
			domain: DOMAIN,
			providerType: 'mta',
			status: 'verified',
			dnsRecords: {},
			createdAt: NOW,
			updatedAt: NOW,
		});
	});
}

/** The seeded `domains` row, as the two seams that take a whole doc want it. */
async function loadDomain(ctx: {
	db: { query: DatabaseReader['query'] };
}): Promise<Doc<'domains'>> {
	const domain = await ctx.db
		.query('domains')
		.withIndex('by_domain', (q) => q.eq('domain', DOMAIN))
		.first();
	if (!domain) throw new Error('expected the seeded domain');
	return domain;
}

async function scheduledNames(t: TestConvex): Promise<string[]> {
	return await t.run(async (ctx) =>
		(await ctx.db.system.query('_scheduled_functions').collect()).map((job) => job.name)
	);
}

describe('the relay-identity registry is composed with the bundled plugin tier', () => {
	it('registers the plugin kind that the primary-provider registry does not hold', () => {
		// The differential heart of the piece. The plugin kind is not a key of the
		// primary registry and the primary guard refuses it — on purpose, since that
		// union governs `domains.providerType`. The relay question is the other one,
		// and it is the one that is open.
		expect(Object.keys(SENDING_DOMAIN_PROVIDERS)).not.toContain(KIND);
		expect(isSendingDomainProviderKind(KIND)).toBe(false);
		expect(relayIdentityProviderFor(KIND)?.kind).toBe(KIND);
	});

	it('keeps every core answer it had', () => {
		// Core membership is structural — an adapter joins iff it implements all
		// three relay seams — so this is the same set the three callers reached for
		// themselves before the registry existed. Our own MTA implements none of
		// them and is correctly absent.
		expect(relayIdentityProviderFor('ses')?.kind).toBe('ses');
		expect(relayIdentityProviderFor('mandrill')?.kind).toBe('mandrill');
		for (const absent of ['mta', 'resend', 'smtp', 'postmark', '__proto__', 'constructor', '']) {
			expect({ absent, provider: relayIdentityProviderFor(absent) }).toEqual({
				absent,
				provider: undefined,
			});
		}
		expect(relayIdentityProviderFor(undefined)).toBeUndefined();
		expect(relayIdentityProviderFor(null)).toBeUndefined();
	});

	it('closes the completeness promise the core-only guards could not see', () => {
		// `_ApiVerifiedKindsHaveDomainProviders` is an `Extract` over the CORE
		// catalog literal, so a bundled plugin entry declaring `api` compiles clean
		// through it. Before this piece the runtime walk in `./registry.test.ts` was
		// the only thing that would have noticed — and it would have FAILED, because
		// no registration existed. This is the property it was waiting for.
		for (const entry of SEND_PROVIDER_CATALOG) {
			if (domainVerificationFor(entry.kind) !== 'api') continue;
			expect({
				kind: entry.kind,
				proven: relayIdentityProviderFor(entry.kind) !== undefined,
			}).toEqual({ kind: entry.kind, proven: true });
		}
		// Non-vacuity: the fixture kind really is in that walk.
		expect(domainVerificationFor(KIND as never)).toBe('api');
	});

	it('implements all three relay seams for the plugin kind', () => {
		const provider = relayIdentityProviderFor(KIND);
		for (const method of [
			'relayDomainVerified',
			'describeReferenceArm',
			'ensureRelayIdentity',
		] as const) {
			expect({ method, implemented: typeof provider?.[method] === 'function' }).toEqual({
				method,
				implemented: true,
			});
		}
	});
});

describe('relayDomainVerification resolves the plugin identity end to end', () => {
	it('credits a fresh, complete proof', async () => {
		const t = convexTest(schema, modules);
		await seedIdentity(t);

		expect(await t.run(async (ctx) => relayDomainVerified(ctx, DOMAIN, KIND, NOW))).toBe(true);
	});

	it('matches the row case-insensitively, as the table is keyed', async () => {
		const t = convexTest(schema, modules);
		await seedIdentity(t);

		expect(
			await t.run(async (ctx) => relayDomainVerified(ctx, DOMAIN.toUpperCase(), KIND, NOW))
		).toBe(true);
	});

	it('refuses a domain with no identity at this relay', async () => {
		const t = convexTest(schema, modules);
		await seedIdentity(t);

		expect(
			await t.run(async (ctx) => relayDomainVerified(ctx, 'other.example.com', KIND, NOW))
		).toBe(false);
	});

	it('never credits another kind’s row for this kind', async () => {
		// The rows share one table; the kind is what separates them. A Mandrill proof
		// must not license relaying through the plugin, or a deployment that once
		// configured a different relay would silently relay through the new one.
		const t = convexTest(schema, modules);
		await seedIdentity(t, { providerKind: 'mandrill' });

		expect(await t.run(async (ctx) => relayDomainVerified(ctx, DOMAIN, KIND, NOW))).toBe(false);
	});

	it.each([
		['an unverified status', { status: 'pending_dns' as const }],
		['a failed status', { status: 'failed' as const }],
		['an invalid SPF verdict', { spf: { isValid: false } }],
		['an invalid DKIM verdict', { dkim: { isValid: false } }],
	])('fails closed on %s', async (_label, overrides) => {
		const t = convexTest(schema, modules);
		await seedIdentity(t, overrides);

		expect(await t.run(async (ctx) => relayDomainVerified(ctx, DOMAIN, KIND, NOW))).toBe(false);
	});

	it('retires a proof past the host’s freshness bound', async () => {
		// The bound is a HOST constant a manifest cannot weaken — it is the only
		// thing that ever retires an identity revoked at the provider while our row
		// survived.
		const t = convexTest(schema, modules);
		await seedIdentity(t, { lastCheckedAt: NOW - PLUGIN_RELAY_PROOF_MAX_AGE_MS - 1 });

		expect(await t.run(async (ctx) => relayDomainVerified(ctx, DOMAIN, KIND, NOW))).toBe(false);
		// One millisecond inside it still counts, so the case above is the bound and
		// not merely "old rows fail".
		const fresh = convexTest(schema, modules);
		await seedIdentity(fresh, { lastCheckedAt: NOW - PLUGIN_RELAY_PROOF_MAX_AGE_MS });
		expect(await fresh.run(async (ctx) => relayDomainVerified(ctx, DOMAIN, KIND, NOW))).toBe(true);
	});

	it('refuses a row dated in the future', async () => {
		const t = convexTest(schema, modules);
		await seedIdentity(t, { lastCheckedAt: NOW + 1 });

		expect(await t.run(async (ctx) => relayDomainVerified(ctx, DOMAIN, KIND, NOW))).toBe(false);
	});

	it('still refuses a kind with no registered identity provider', async () => {
		const t = convexTest(schema, modules);
		await seedIdentity(t);

		for (const kind of ['smtp', 'resend', 'mta', 'plugin.other-pack.relay']) {
			expect({
				kind,
				verified: await t.run(async (ctx) => relayDomainVerified(ctx, DOMAIN, kind, NOW)),
			}).toEqual({ kind, verified: false });
		}
	});
});

describe('the reference arm is built from what a proven observation recorded', () => {
	it('describes the arm for a proven domain', async () => {
		const t = convexTest(schema, modules);
		await seedIdentity(t);
		await seedDomain(t);

		const arm = await t.run(async (ctx) =>
			relayIdentityProviderFor(KIND)!.describeReferenceArm(ctx, await loadDomain(ctx), NOW)
		);

		expect(arm).toEqual({
			label: 'Postmark',
			fromDomain: DOMAIN,
			dkimDomain: DOMAIN,
			dkimSelectors: ['pm-bounces'],
			spfMechanisms: ['include:spf.postmarkapp.example'],
			// Never true at this tier: the VERP local part that makes a bounce
			// attributable is signed with a deployment secret a module is not handed.
			supportsCustomReturnPath: false,
		});
	});

	it('holds the ramp rather than guessing when the proof is not fresh', async () => {
		const t = convexTest(schema, modules);
		await seedIdentity(t, { status: 'pending_dns' });
		await seedDomain(t);

		const arm = await t.run(async (ctx) =>
			relayIdentityProviderFor(KIND)!.describeReferenceArm(ctx, await loadDomain(ctx), NOW)
		);

		expect(arm).toBeNull();
	});

	it('holds the ramp when a proven observation recorded no DKIM selector', async () => {
		// An arm with no selector would be resolved live by the pre-flight, find
		// nothing, and be reported to the operator as a DKIM misalignment on DNS
		// they published correctly. `null` reads as `unknown` — a hold, with the
		// actionable sentence.
		const t = convexTest(schema, modules);
		await seedIdentity(t, { providerDetails: JSON.stringify({ kind: 'plugin' }) });
		await seedDomain(t);

		const arm = await t.run(async (ctx) =>
			relayIdentityProviderFor(KIND)!.describeReferenceArm(ctx, await loadDomain(ctx), NOW)
		);

		expect(arm).toBeNull();
	});
});

describe('the identity backfill schedules the provider call', () => {
	it('schedules the plugin’s provision action for a domain with no identity yet', async () => {
		const t = convexTest(schema, modules);
		await seedDomain(t);

		await t.run(async (ctx) => {
			await relayIdentityProviderFor(KIND)!.ensureRelayIdentity(ctx, await loadDomain(ctx), {
				reprovision: false,
			});
		});

		expect(await scheduledNames(t)).toEqual(['domains/pluginRelay:provision']);
	});

	it('converges for the drain: an existing row is done', async () => {
		const t = convexTest(schema, modules);
		await seedDomain(t);
		await seedIdentity(t);

		await t.run(async (ctx) => {
			await relayIdentityProviderFor(KIND)!.ensureRelayIdentity(ctx, await loadDomain(ctx), {
				reprovision: false,
			});
		});

		expect(await scheduledNames(t)).toEqual([]);
	});

	it('repeats for the operator’s repair lever, existing row or not', async () => {
		// The forward path's `→ verified` edge is the ONLY way to re-register an
		// identity deleted at the provider while our row survived, so it must not be
		// short-circuited by the row it is repairing.
		const t = convexTest(schema, modules);
		await seedDomain(t);
		await seedIdentity(t);

		await t.run(async (ctx) => {
			await relayIdentityProviderFor(KIND)!.ensureRelayIdentity(ctx, await loadDomain(ctx), {
				reprovision: true,
			});
		});

		expect(await scheduledNames(t)).toEqual(['domains/pluginRelay:provision']);
	});

	it('names the action the sweep and the backfill both reach', () => {
		// A string in a test is not a wire; this is the generated reference, so a
		// renamed action fails the build rather than leaving the two schedulers
		// pointing at nothing.
		expect(internal.domains.pluginRelay.provision).toBeDefined();
		expect(internal.domains.pluginRelay.refreshIdentity).toBeDefined();
	});
});
