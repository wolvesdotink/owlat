/**
 * THE ROWS LAND IN `sendingDomainRelayIdentities`, KEYED BY THE NAMESPACED KIND
 * (the seams plan's P3.2, and D10's rows-not-columns half).
 *
 * The registry gate beside this one proves the READ — that a plugin identity row
 * resolves through `relayDomainVerification` end to end. This one proves the
 * WRITE, which is the half that has to exist for the read ever to be true, and
 * every fail-closed rule around it:
 *
 *  - the row is written under `providerKind: 'plugin.<id>.<local>'`, in the
 *    generic table, with no schema change and no column of its own;
 *  - a revoked grant makes no provider call at all — turning a plugin off has to
 *    stop it spending this deployment's credential at a third party — while still
 *    moving the retry, or the hourly sweep would re-ask a disabled plugin's rows
 *    forever;
 *  - an unset credential, a module that throws, and a provider outage each write
 *    NOTHING that could be mistaken for evidence: `lastCheckedAt` is what the
 *    proof's age is measured from, so a failure path that advanced it would keep
 *    a stale proof alive by failing;
 *  - a rejected credential is terminal and says so, without overwriting the
 *    SPF/DKIM verdicts an operator's DNS earned.
 */

import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KIND = 'plugin.mail-pack.postmark';
const PLUGIN_ID = 'mail-pack';
const DOMAIN = 'sender.example.com';

const { registerDomainMock, checkDomainMock, authorizeMock } = vi.hoisted(() => ({
	registerDomainMock: vi.fn(),
	checkDomainMock: vi.fn(),
	authorizeMock: vi.fn(),
}));

vi.mock('../../plugins/sendTransportCatalog.generated', () => ({
	BUNDLED_PLUGIN_SEND_TRANSPORT_CATALOG: Object.freeze([
		Object.freeze({
			kind: KIND,
			pluginId: PLUGIN_ID,
			localId: 'postmark',
			label: 'Postmark',
			retryDelays: Object.freeze([0]),
			requiredEnvVars: Object.freeze(['PLUGIN_POSTMARK_TOKEN']),
			instanceEnvVars: Object.freeze(['PLUGIN_POSTMARK_TOKEN']),
			domainVerification: 'api',
			requiredCapability: 'send:transport',
		}),
	]),
}));

vi.mock('../../plugins/sendTransportDomainIdentityCatalog.generated', () => ({
	BUNDLED_PLUGIN_SEND_TRANSPORT_DOMAIN_IDENTITY_CATALOG: Object.freeze([
		Object.freeze({
			kind: KIND,
			pluginId: PLUGIN_ID,
			localId: 'postmark',
			label: 'Postmark',
			instanceEnvVars: Object.freeze(['PLUGIN_POSTMARK_TOKEN', 'PLUGIN_POSTMARK_REGION']),
			requiredEnvVars: Object.freeze(['PLUGIN_POSTMARK_TOKEN']),
			requiredCapability: 'send:transport',
		}),
	]),
}));

vi.mock('../../plugins/sendTransportDomainIdentityModules.generated', () => ({
	BUNDLED_PLUGIN_SEND_TRANSPORT_DOMAIN_IDENTITY_MODULES: Object.freeze([
		Object.freeze({
			kind: KIND,
			pluginId: PLUGIN_ID,
			module: {
				registerDomain: (domain: string, config: unknown) => registerDomainMock(domain, config),
				checkDomain: (domain: string, config: unknown) => checkDomainMock(domain, config),
			},
		}),
	]),
}));

/**
 * The grant recheck itself is `hostedContributionAuthorization`'s, and it has its
 * own suite. Stubbed here so these cases are about what the identity path DOES
 * with the answer — including the denial arm, which is the one that must make no
 * provider call at all.
 */
vi.mock('../../plugins/hostedContributionAuthorization', async () => {
	const actual = await vi.importActual<
		typeof import('../../plugins/hostedContributionAuthorization')
	>('../../plugins/hostedContributionAuthorization');
	return {
		...actual,
		authorizeHostedContribution: (...args: unknown[]) => authorizeMock(...args),
		recordHostedContributionOutcome: async () => {},
	};
});

vi.mock('../../lib/sessionOrganization', async () => {
	const actual = await vi.importActual<typeof import('../../lib/sessionOrganization')>(
		'../../lib/sessionOrganization'
	);
	return { ...actual, getSingletonOrganizationId: vi.fn().mockResolvedValue('org-a') };
});

const schema = (await import('../../schema')).default;
const { modules } = await import('../../__tests__/testModules');
const { internal } = await import('../../_generated/api');
const { PLUGIN_CHECK_INTERVAL_MS, PLUGIN_DENIED_RETRY_MS, PLUGIN_UNAVAILABLE_RETRY_MS } =
	await import('../providers/plugin/state');

type TestConvex = ReturnType<typeof convexTest>;

function providerState(overrides: Record<string, unknown> = {}) {
	return {
		outcome: 'ok',
		state: {
			isOwnershipVerified: true,
			spf: { isValid: true },
			dkim: { isValid: true },
			dkimSelectors: ['pm-bounces'],
			spfMechanisms: ['include:spf.postmarkapp.example'],
			...overrides,
		},
	};
}

async function rows(t: TestConvex) {
	return await t.run(async (ctx) => ctx.db.query('sendingDomainRelayIdentities').collect());
}

beforeEach(() => {
	registerDomainMock.mockReset();
	checkDomainMock.mockReset();
	authorizeMock.mockReset().mockResolvedValue(true);
	vi.stubEnv('PLUGIN_POSTMARK_TOKEN', 'token-value');
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('provision writes the identity row', () => {
	it('lands one row under the namespaced kind, with the host’s derived status', async () => {
		const t = convexTest(schema, modules);
		registerDomainMock.mockResolvedValue(providerState());

		const result = await t.action(internal.domains.pluginRelay.provision, {
			kind: KIND,
			domain: DOMAIN,
		});

		expect(result).toEqual({ outcome: 'checked' });
		const [row] = await rows(t);
		expect({
			providerKind: row?.providerKind,
			domain: row?.domain,
			status: row?.status,
			spf: row?.spf,
			dkim: row?.dkim,
		}).toEqual({
			// D10: a plain string field on the generic table. No schema change, no
			// per-provider sibling, no column for the tier.
			providerKind: KIND,
			domain: DOMAIN,
			status: 'verified',
			spf: { isValid: true },
			dkim: { isValid: true },
		});
		expect(JSON.parse(row!.providerDetails!)).toEqual({
			kind: 'plugin',
			dkimSelectors: ['pm-bounces'],
			spfMechanisms: ['include:spf.postmarkapp.example'],
		});
		expect(row!.nextCheckDueAt).toBe(row!.lastCheckedAt + PLUGIN_CHECK_INTERVAL_MS.verified);
	});

	it('hands the module only this transport’s declared variables, by base name', async () => {
		// The plugin's deployment-wide flag variables are the plugin's, not this
		// transport's; an optional one the deployment never set is simply absent.
		const t = convexTest(schema, modules);
		registerDomainMock.mockResolvedValue(providerState());

		await t.action(internal.domains.pluginRelay.provision, { kind: KIND, domain: DOMAIN });

		expect(registerDomainMock).toHaveBeenCalledWith(DOMAIN, {
			instanceKey: null,
			env: { PLUGIN_POSTMARK_TOKEN: 'token-value' },
		});
	});

	it('upserts rather than duplicating on a second provision', async () => {
		const t = convexTest(schema, modules);
		registerDomainMock.mockResolvedValue(providerState());

		await t.action(internal.domains.pluginRelay.provision, { kind: KIND, domain: DOMAIN });
		await t.action(internal.domains.pluginRelay.provision, { kind: KIND, domain: DOMAIN });

		expect(await rows(t)).toHaveLength(1);
	});

	it('does nothing at all for a kind no bundled plugin registered', async () => {
		const t = convexTest(schema, modules);

		const result = await t.action(internal.domains.pluginRelay.provision, {
			kind: 'plugin.gone.relay',
			domain: DOMAIN,
		});

		expect(result).toEqual({ outcome: 'unregistered' });
		expect(authorizeMock).not.toHaveBeenCalled();
		expect(await rows(t)).toEqual([]);
	});
});

describe('the due-check sweep asks the registry for its dispatch arm', () => {
	async function seedDueRow(t: TestConvex, providerKind: string): Promise<void> {
		await t.run(async (ctx) => {
			await ctx.db.insert('sendingDomainRelayIdentities', {
				organizationId: 'org-a',
				domain: `${providerKind}.example`,
				providerKind,
				status: 'verified',
				lastCheckedAt: 1_000,
				nextCheckDueAt: 1_000,
				createdAt: 1_000,
				updatedAt: 1_000,
			});
		});
	}

	it('sweeps a bundled plugin identity the day it composes', async () => {
		// The sweep is what keeps a live proof inside the freshness bound, so a
		// registered kind that is not on it loses the ability to relay a domain
		// nothing is wrong with. The arm is asked of the registry rather than added
		// as a second kind literal, which is why a plugin kind needs no edit here.
		const t = convexTest(schema, modules);
		await seedDueRow(t, KIND);

		expect(await t.mutation(internal.domains.mandrillRelayMutations.scheduleDueChecks, {})).toBe(1);
		const scheduled = await t.run(async (ctx) =>
			(await ctx.db.system.query('_scheduled_functions').collect()).map((job) => job.name)
		);
		expect(scheduled).toEqual(['domains/pluginRelay:refreshIdentity']);
	});

	it('leaves a row whose kind nothing registered alone', async () => {
		// A row can outlive its plugin (a composition that dropped the package).
		// Skipping is the honest answer; there is nothing left to ask.
		const t = convexTest(schema, modules);
		await seedDueRow(t, 'plugin.gone.relay');

		expect(await t.mutation(internal.domains.mandrillRelayMutations.scheduleDueChecks, {})).toBe(0);
	});
});

describe('every failure path refuses to look like evidence', () => {
	it('makes no provider call when the grant is revoked', async () => {
		const t = convexTest(schema, modules);
		authorizeMock.mockResolvedValue(false);

		const result = await t.action(internal.domains.pluginRelay.provision, {
			kind: KIND,
			domain: DOMAIN,
		});

		expect(result).toEqual({ outcome: 'denied' });
		expect(registerDomainMock).not.toHaveBeenCalled();
		expect(await rows(t)).toEqual([]);
	});

	it('takes a denied row OUT of the due set instead of re-asking it forever', async () => {
		// THE SWEEP HAS TO TERMINATE. `nextCheckDueAt` is the only thing that takes
		// a row out of `by_next_check_due`, so a denial that wrote nothing would
		// leave every row of a disabled plugin permanently due: one scheduled action
		// and one `access_denied` audit row per row, every tick, for as long as the
		// operator leaves the plugin off — a state they deliberately chose.
		const t = convexTest(schema, modules);
		registerDomainMock.mockResolvedValue(providerState());
		await t.action(internal.domains.pluginRelay.provision, { kind: KIND, domain: DOMAIN });
		const before = (await rows(t))[0]!;

		authorizeMock.mockResolvedValue(false);
		const result = await t.action(internal.domains.pluginRelay.refreshIdentity, {
			kind: KIND,
			domain: DOMAIN,
		});

		expect(result).toEqual({ outcome: 'denied' });
		expect(checkDomainMock).not.toHaveBeenCalled();
		const after = (await rows(t))[0]!;
		expect(after.nextCheckDueAt).toBeGreaterThan(Date.now());
		expect(after.nextCheckDueAt).toBeLessThanOrEqual(Date.now() + PLUGIN_DENIED_RETRY_MS);
		// AND IT IS STILL NOT EVIDENCE. A revoked grant is not a check: it may not
		// refresh the proof's age, may not touch the verdicts, and may not condemn a
		// credential nobody rejected.
		expect({
			status: after.status,
			spf: after.spf,
			dkim: after.dkim,
			lastCheckedAt: after.lastCheckedAt,
			providerDetails: after.providerDetails,
		}).toEqual({
			status: 'verified',
			spf: before.spf,
			dkim: before.dkim,
			lastCheckedAt: before.lastCheckedAt,
			providerDetails: before.providerDetails,
		});
	});

	it('makes no provider call when a required credential is unset', async () => {
		const t = convexTest(schema, modules);
		vi.stubEnv('PLUGIN_POSTMARK_TOKEN', '');

		const result = await t.action(internal.domains.pluginRelay.provision, {
			kind: KIND,
			domain: DOMAIN,
		});

		expect(result).toEqual({ outcome: 'auth_failed' });
		expect(registerDomainMock).not.toHaveBeenCalled();
		// And it invents no row: a deployment with no identity here and no key has
		// nothing to say about a domain.
		expect(await rows(t)).toEqual([]);
	});

	it('treats a module that threw as an outage, not as a verdict', async () => {
		const t = convexTest(schema, modules);
		registerDomainMock.mockResolvedValue(providerState());
		await t.action(internal.domains.pluginRelay.provision, { kind: KIND, domain: DOMAIN });
		const before = (await rows(t))[0]!;

		checkDomainMock.mockRejectedValue(new Error('boom'));
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		const result = await t.action(internal.domains.pluginRelay.refreshIdentity, {
			kind: KIND,
			domain: DOMAIN,
		});
		logged.mockRestore();

		expect(result).toEqual({ outcome: 'unavailable' });
		const after = (await rows(t))[0]!;
		// The verdicts and the proof's AGE are untouched — only when to ask again
		// moved. A long outage must not keep a stale proof alive by being unable to
		// re-confirm it.
		expect({ status: after.status, spf: after.spf, lastCheckedAt: after.lastCheckedAt }).toEqual({
			status: 'verified',
			spf: before.spf,
			lastCheckedAt: before.lastCheckedAt,
		});
		expect(after.nextCheckDueAt).toBeLessThanOrEqual(Date.now() + PLUGIN_UNAVAILABLE_RETRY_MS);
	});

	it('records a rejected credential as terminal without overwriting the DNS verdicts', async () => {
		const t = convexTest(schema, modules);
		registerDomainMock.mockResolvedValue(providerState());
		await t.action(internal.domains.pluginRelay.provision, { kind: KIND, domain: DOMAIN });
		const before = (await rows(t))[0]!;

		checkDomainMock.mockResolvedValue({ outcome: 'auth_failed', error: 'invalid token' });
		const result = await t.action(internal.domains.pluginRelay.refreshIdentity, {
			kind: KIND,
			domain: DOMAIN,
		});

		expect(result).toEqual({ outcome: 'auth_failed' });
		const after = (await rows(t))[0]!;
		// A bad API key is not evidence that the operator's DNS stopped being valid;
		// overwriting the verdicts would tell them to republish records that are fine.
		expect({ status: after.status, spf: after.spf, dkim: after.dkim }).toEqual({
			status: 'failed',
			spf: before.spf,
			dkim: before.dkim,
		});
		expect(after.lastCheckedAt).toBe(before.lastCheckedAt);
		// The reason is stored, and the DNS facts the last real observation recorded
		// survive it: a rejected key says nothing about what the provider signs this
		// domain under, and the alignment pre-flight still needs them.
		expect(JSON.parse(after.providerDetails!)).toEqual({
			kind: 'plugin',
			dkimSelectors: ['pm-bounces'],
			spfMechanisms: ['include:spf.postmarkapp.example'],
			lastError: 'invalid token',
		});
	});

	it('reads an unparsable module answer as an outage', async () => {
		const t = convexTest(schema, modules);
		registerDomainMock.mockResolvedValue({ nonsense: true });

		const result = await t.action(internal.domains.pluginRelay.provision, {
			kind: KIND,
			domain: DOMAIN,
		});

		expect(result).toEqual({ outcome: 'unavailable' });
		expect(await rows(t)).toEqual([]);
	});
});
