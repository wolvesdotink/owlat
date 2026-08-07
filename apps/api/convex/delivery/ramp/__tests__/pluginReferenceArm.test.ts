/**
 * ARM ATTRIBUTION WITH A PLUGIN TRANSPORT AS THE REFERENCE ARM (the seams plan's
 * P3.3, its acceptance criterion A4) — the ramp half of the parity proof.
 *
 * The conformance suite (`examples/conformance/src/__tests__/pluginProviderParity.test.ts`)
 * proves everything a pure module can be asked: routing under every declared
 * strategy, fallback eligibility, the return-path fold, the feedback route's
 * verification chain, the domain-identity split and the credential form. What it
 * cannot prove is what only exists across a database — that an operator can SAVE
 * a route naming a composed plugin kind, and that a plugin transport's outcomes
 * land on the RIGHT ARM through the real relay writers and the real hourly tick.
 *
 * That second property is the whole reason the plugin tier is worth having. If a
 * plugin relay's bounces, complaints or deferrals leaked into the OWN arm's
 * counters, a deployment ramping onto its own MTA would watch the ramp freeze
 * and retreat because of mail Owlat never sent, with no way to tell that from an
 * unhealthy MTA. The converse leak is worse: own-arm damage credited to the
 * plugin arm would let a failing MTA keep climbing on a third party's good name.
 *
 * WHAT THE TWO MOCKED ARTIFACTS ARE FOR, precisely — because most of this file
 * does not read them. Attribution is decided once, at assignment time
 * (`armForTransport`: the own MTA is `own`, EVERY other transport kind is
 * `reference`), the recorder reads the stored `arm` column rather than
 * re-deriving it, and `configuredRelayKinds` answers off `providerRoutes` rows as
 * strings — so nothing on the cron's path consults the send-provider catalog at
 * all, and `plugin.mock-esp.relay` is `reference` by the same rule `'ses'` and
 * `'mandrill'` are. THAT IS THE FINDING, and the first describe block below
 * states it. The composed catalog and the plugin roster are mocked because ONE
 * door does read them: `providerRoutes.setRoute` validates the kind through
 * `isSendProviderKind` and its readiness through `isSendProviderReady`, which
 * resolves the entry's `pluginId` and re-checks the operator's capability grant.
 * That door is the last describe block, and without these two mocks it refuses
 * the kind — which is what makes them load-bearing rather than decoration.
 *
 * THE ENTRY IS HAND-WRITTEN because `apps/api` may not import from `examples/`,
 * and it is a NARROWING of what the renderer emits rather than a transcription of
 * it — see the note on the mock itself for which fields are here and which reader
 * each one has. The binding to the real composition is asserted from the
 * conformance side rather than claimed here.
 */

import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** The conformance fixture's transport kind. Owned by `examples/conformance/`. */
const KIND = 'plugin.mock-esp.relay';
const PLUGIN_ID = 'mock-esp';

/**
 * THE COMPOSED ENTRY, NARROWED TO WHAT THIS FILE'S CODE PATHS READ.
 *
 * It is NOT a transcription of the whole artifact, and saying so is the point: a
 * transcribed copy of `label`, `retryDelays`, `hasProviderFeedback`, the
 * credential fields' prose and the region field's default would be forty lines
 * nothing here reaches and nothing binds, free to drift from the manifest that
 * really produces them while this suite stayed green. Each field below has a
 * reader on a path this file drives:
 *
 *   `kind`, `pluginId`     `isSendProviderKind` / `isSendProviderReady`, which is
 *                          how the operator's door resolves the grant to recheck
 *   `requiredEnvVars`      `providerKindConfigured` — the credentials gate
 *   `instanceEnvVars`,     the catalog's own LOAD-TIME guards
 *   `credentialFields`     (`assertPluginConfigurationIsWithinContract`: the
 *                          `PLUGIN_` namespace and the per-entry bounds), which
 *                          run on import of `lib/sendProviders/catalog.ts`
 *   `supportsCustomReturnPath`, `assertPluginReturnPathClaimsAreHonest` and
 *   `messageIdSource`      `assertPluginDispatchSemanticsAreGeneral`, same import
 *
 * EVERY value below is bound to the real composition from the conformance side.
 * That suite (`binds the ramp fixture to every value of the composed entry's
 * narrowed copy`, and the roster case beside it) reads this file and requires it
 * to spell the composed kind, every `requiredEnvVars` / `instanceEnvVars` entry,
 * each credential field's variable WITH its kind and required-ness, and the two
 * capability values — so a rename, a renderer that stopped folding the flag's
 * variables in, or a tightened load-time guard fails there rather than leaving
 * this suite satisfying a guard with a value the bundle no longer declares.
 */
vi.mock('../../../plugins/sendTransportCatalog.generated', () => ({
	BUNDLED_PLUGIN_SEND_TRANSPORT_CATALOG: Object.freeze([
		Object.freeze({
			kind: 'plugin.mock-esp.relay',
			pluginId: 'mock-esp',
			requiredEnvVars: Object.freeze([
				'MOCK_ESP_ENABLED',
				'PLUGIN_MOCK_ESP_WEBHOOK_SECRET',
				'PLUGIN_MOCK_ESP_TOKEN',
			]),
			instanceEnvVars: Object.freeze(['PLUGIN_MOCK_ESP_TOKEN', 'PLUGIN_MOCK_ESP_REGION']),
			credentialFields: Object.freeze([
				Object.freeze({ kind: 'secret', required: true, envVar: 'PLUGIN_MOCK_ESP_TOKEN' }),
				Object.freeze({ kind: 'select', envVar: 'PLUGIN_MOCK_ESP_REGION' }),
			]),
			supportsCustomReturnPath: 'no',
			messageIdSource: 'provider',
		}),
	]),
}));

/**
 * THE ROSTER, narrowed the same way and bound the same way: the operator's door
 * resolves the plugin's flag and capability grant through it, and the conformance
 * suite requires this copy to spell the composed package name, manifest id and
 * version, every declared capability and every variable the flag requires.
 */
vi.mock('../../../plugins/plugins.generated', () => ({
	bundledPluginComposition: Object.freeze([
		Object.freeze({
			packageName: '@acme/mock-esp',
			manifest: Object.freeze({
				id: 'mock-esp',
				version: '1.0.0',
				capabilities: Object.freeze(['send:transport']),
				flag: Object.freeze({
					default: false,
					requiredEnvVars: Object.freeze(['MOCK_ESP_ENABLED', 'PLUGIN_MOCK_ESP_WEBHOOK_SECRET']),
				}),
			}),
		}),
	]),
}));

import schema from '../../../schema';
import { api, internal } from '../../../_generated/api';
import { modules } from '../../../__tests__/testModules';
import { drainOutcomeWrites } from '../../../analytics/__tests__/transportOutcomesFixtures';
import { armForTransport } from '../../sendAssignments';
import type { SendProviderKind } from '../../../lib/sendProviders/types';
import { configuredRelayKinds } from '../../relayConfiguration';
import {
	armOutcomeTotals,
	RAMP_FIXTURE_GATE_BREACHING_BURST,
	RAMP_FIXTURE_SHARE,
	readManagedCell,
	readMixDecision,
	runRampControllerTick,
	seedArmOutcomes,
	seedAssignedSend,
	seedRampCell,
	seedRelayMigration,
	type Harness,
} from '../../__tests__/rampCronFixtures';

const ORG = 'org_plugin_reference_arm';

vi.mock('../../../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../lib/sessionOrganization')>();
	return {
		...actual,
		getSingletonOrganizationId: vi.fn().mockResolvedValue('org_plugin_reference_arm'),
		// The operator's door (`setRoute`) is an authed mutation whose handler also
		// asks for `organization:manage`. Nothing here stands up a BetterAuth
		// component to answer either, and neither is what this suite is about.
		requireOrgMember: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		isActiveOrgMember: vi.fn().mockResolvedValue(true),
		getUserIdFromSession: vi.fn().mockResolvedValue('test-user'),
		getMutationContext: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
		requireOrgPermission: vi.fn().mockResolvedValue({ userId: 'test-user', role: 'owner' }),
	};
});

/**
 * The authed caller the operator's door needs. Applied per CALL rather than to
 * the runner, so the seeding fixtures keep taking the bare harness — the two
 * handles read and write the same backend.
 */
const IDENTITY = {
	subject: 'test-user',
	issuer: 'https://test.issuer.com',
	tokenIdentifier: 'https://test.issuer.com|test-user',
};

afterEach(() => {
	vi.unstubAllEnvs();
});

/**
 * A DEPLOYMENT MID-RAMP with a PLUGIN relay: half the cell's traffic still going
 * through `@acme/mock-esp`, a healthy history on both arms, and the plugin kind
 * named in `providerRoutes` under the one strategy that splits by the cell's
 * share.
 *
 * The state itself is the shared fixture's, which is the whole point of this
 * suite: what makes it a PLUGIN deployment is the relay kind and nothing else, and
 * a second hand-rolled copy of the seeding would be free to drift from the
 * Mandrill suite it is meant to be comparable with.
 */
async function seedPluginMigration(t: Harness): Promise<void> {
	await seedRelayMigration(t, { organizationId: ORG, relayKind: KIND });
}

describe('a plugin transport is the reference arm by configuration and by attribution', () => {
	// The premise of every case below, stated rather than assumed: a stray route
	// row or an ambient env would otherwise leave this suite measuring SES. It is
	// also the proof that the namespaced kind survives the relay DISCOVERY path —
	// `configuredRelayKinds` reads `providerRoutes` and keeps whatever is not the
	// own MTA, so a plugin kind is a second sender on the same terms.
	it('is discovered as the deployment relay kind', async () => {
		const t = convexTest(schema, modules);
		await seedPluginMigration(t);

		expect(await t.run(async (ctx) => await configuredRelayKinds(ctx))).toEqual([KIND]);
	});

	// The rule, asked directly, before any of the cron machinery reads it: the
	// assignment writer asks only whether the transport is the own MTA. Naming the
	// plugin id keeps this honest about WHICH kind is being graded.
	it('grades the plugin kind reference and the own MTA own', () => {
		expect(KIND.startsWith(`plugin.${PLUGIN_ID}.`)).toBe(true);
		// The cast is the composed catalog's absence at COMPILE time, not a
		// weakening: `SendProviderKind` is derived from the generated artifact, which
		// ships empty in this repository, so a plugin kind can only be a string until
		// a deployment composes one. Every core-side plugin suite spells it the same
		// way.
		expect(armForTransport(KIND as SendProviderKind)).toBe('reference');
		expect(armForTransport('mta')).toBe('own');
	});

	it('lands a plugin relay deferral on the reference arm, not the own arm', async () => {
		const t = convexTest(schema, modules);
		await seedPluginMigration(t);
		await seedAssignedSend(t, {
			organizationId: ORG,
			providerMessageId: 'plugin-msg-deferred',
			transport: KIND,
			arm: 'reference',
		});
		const before = {
			own: await armOutcomeTotals(t, 'own'),
			reference: await armOutcomeTotals(t, 'reference'),
		};

		// The exact mutation the plugin feedback route's `email.deferred` dispatch
		// runs — the same writer a core relay's deferral webhook reaches.
		const result = await t.mutation(internal.delivery.deferralOutcome.recordRelayDeferral, {
			providerMessageId: 'plugin-msg-deferred',
			at: Date.now(),
		});
		await drainOutcomeWrites(t);

		expect(result).toBe('observed');
		expect((await armOutcomeTotals(t, 'reference')).deferred).toBe(before.reference.deferred + 1);
		// THE POINT: gate 2 divides the OWN arm's deferrals, and a third party
		// holding its own mail must never enter that numerator.
		expect((await armOutcomeTotals(t, 'own')).deferred).toBe(before.own.deferred);
	});

	// THE CONTROL for the case above — same writer, same cell, the only difference
	// being which arm the assignment names.
	it('lands an own-MTA deferral on the own arm', async () => {
		const t = convexTest(schema, modules);
		await seedPluginMigration(t);
		await seedAssignedSend(t, {
			organizationId: ORG,
			providerMessageId: 'mta-msg-deferred',
			transport: 'mta',
			arm: 'own',
		});
		const before = {
			own: await armOutcomeTotals(t, 'own'),
			reference: await armOutcomeTotals(t, 'reference'),
		};

		await t.mutation(internal.delivery.deferralOutcome.recordRelayDeferral, {
			providerMessageId: 'mta-msg-deferred',
			at: Date.now(),
		});
		await drainOutcomeWrites(t);

		expect((await armOutcomeTotals(t, 'own')).deferred).toBe(before.own.deferred + 1);
		expect((await armOutcomeTotals(t, 'reference')).deferred).toBe(before.reference.deferred);
	});
});

/**
 * THE WHOLE TICK, ONCE, OVER A NAMESPACED KIND — and deliberately only once.
 *
 * `mandrillReferenceArm.test.ts` owns the controller's freeze/decrease semantics
 * against a reference arm: the clean climb, the reference-arm burst that must not
 * move the own share, the own-arm burst that freezes and names its gate, the
 * reference counters left untouched by a retreat. Restating them here with the
 * kind swapped would be a byte-identical second copy of a rule whose every
 * assertion is kind-blind — the next `freezeReason` or `failedGate` change would
 * have to be applied to both, and applying it to one would leave the other green
 * on stale expectations. That is the duplication class this plan exists to
 * remove.
 *
 * WHAT IS NOT A COPY, and is the case below: `'mandrill'` is a CORE kind and
 * `plugin.mock-esp.relay` is not. Everything the tick touches — the relay
 * discovery read, the cell key, the arm columns, the audited decision — takes the
 * transport as an opaque string today, and this drives a full tick to keep that
 * true: a controller path that started resolving the configured relay through a
 * core-only lookup, or choking on a dotted kind, would pass the Mandrill suite
 * and fail here. One case, because one is what that question needs.
 *
 * It runs the REFERENCE-ARM BURST rather than the bare climb, which is strictly
 * stronger: the assertion is `direction: 'increase'`, so a deployment that was
 * not ramping fails it just as a leaked reference burst does.
 */
describe('the real tick runs a plugin-relay deployment end to end', () => {
	it('climbs through a plugin-arm burst, on a kind no core catalog contains', async () => {
		const t = convexTest(schema, modules);
		await seedPluginMigration(t);
		await seedArmOutcomes(t, {
			organizationId: ORG,
			arm: 'reference',
			...RAMP_FIXTURE_GATE_BREACHING_BURST,
		});

		await runRampControllerTick(t);

		const row = await readManagedCell(t);
		expect(row?.ownShare).toBeGreaterThan(RAMP_FIXTURE_SHARE);
		expect(row?.frozenUntil).toBeUndefined();
		const audited = await readMixDecision(t);
		expect(audited).toMatchObject({ direction: 'increase', verdict: 'pass' });
		expect(audited?.failedGate).toBeUndefined();
	});
});

/**
 * THE OPERATOR'S DOOR, which is where the composed catalog is actually read.
 *
 * Every fixture above writes its `providerRoutes` row straight into the database,
 * because what they measure is downstream of the row existing. This block is the
 * question none of them asks and the shipped `providerRoutes.integration.test.ts`
 * only covers in the negative (a RETIRED plugin kind, refused): can an operator
 * save a route naming a composed plugin kind at all? `setRoute` validates it
 * through `isSendProviderKind` — the composed catalog — and then through
 * `isSendProviderReady`, which for a plugin kind resolves the entry's `pluginId`
 * and re-checks the deployment's flag, the operator's capability grant and the
 * manifest's own required variables. Four separate reads of the two mocked
 * artifacts, and the reason they are here.
 */
describe('an operator can route to a composed plugin kind, and only when it is granted', () => {
	/**
	 * The plugin's two switches, as the operator's settings singleton stores them,
	 * and INDEPENDENTLY — because `authorizeSystemBundledPlugin` reads them as two
	 * gates and a case that moves both cannot say which one refused. A refactor
	 * that dropped the capability check and kept only the flag has to be visible
	 * here; with one boolean it would not be.
	 */
	async function grantPlugin(
		t: Harness,
		switches: { readonly isFlagEnabled: boolean; readonly isGranted: boolean }
	): Promise<void> {
		await t.run(async (ctx) => {
			const settings = await ctx.db.query('instanceSettings').first();
			if (!settings) throw new Error('the ramp fixture seeds instance settings');
			await ctx.db.patch(settings._id, {
				featureFlags: { ...settings.featureFlags, [`plugin.${PLUGIN_ID}`]: switches.isFlagEnabled },
				pluginCapabilityGrants: {
					...settings.pluginCapabilityGrants,
					[`plugin.${PLUGIN_ID}`]: { 'send:transport': switches.isGranted },
				},
			});
		});
	}

	/** Everything the plugin declares it needs before any of it counts as configured. */
	function configurePlugin(): void {
		vi.stubEnv('MOCK_ESP_ENABLED', 'true');
		vi.stubEnv('PLUGIN_MOCK_ESP_WEBHOOK_SECRET', 'whsec-mock-esp');
		vi.stubEnv('PLUGIN_MOCK_ESP_TOKEN', 'tok-live');
	}

	function pluginRoute() {
		return {
			messageType: 'campaign' as const,
			strategy: 'adaptive_mix' as const,
			providers: [
				{ providerType: 'mta', isEnabled: true },
				{ providerType: KIND, isEnabled: true },
			],
		};
	}

	it('saves a route naming the plugin kind when flag, grant and credentials are present', async () => {
		const t = convexTest(schema, modules);
		await seedRampCell(t, { organizationId: ORG, ownShare: RAMP_FIXTURE_SHARE, cleanStreak: 3 });
		await grantPlugin(t, { isFlagEnabled: true, isGranted: true });
		configurePlugin();

		expect(
			await t.withIdentity(IDENTITY).mutation(api.providerRoutes.setRoute, pluginRoute())
		).toBeTruthy();
		// And the row the whole ramp half reads is the one the mutation wrote.
		expect(await t.run(async (ctx) => await configuredRelayKinds(ctx))).toEqual([KIND]);
	});

	// FAIL CLOSED, on the axis only the plugin tier has: the kind is composed, its
	// credentials are present and the plugin is ENABLED, but the operator has not
	// granted (or has revoked) `send:transport`. A core kind has no such gate, and
	// a plugin kind must not be routable without it. Flag on, grant off — so the
	// refusal can only be the grant.
	it('refuses the same route when the capability grant is absent', async () => {
		const t = convexTest(schema, modules);
		await seedRampCell(t, { organizationId: ORG, ownShare: RAMP_FIXTURE_SHARE, cleanStreak: 3 });
		await grantPlugin(t, { isFlagEnabled: true, isGranted: false });
		configurePlugin();

		await expect(
			t.withIdentity(IDENTITY).mutation(api.providerRoutes.setRoute, pluginRoute())
		).rejects.toThrow();
		expect(await t.run(async (ctx) => await configuredRelayKinds(ctx))).toEqual([]);
	});

	// THE MIRROR, and the reason the two switches are separate: a plugin the
	// operator has turned OFF is not routable however broadly it was once granted.
	// Together with the case above, neither gate can be dropped without one of them
	// going red.
	it('refuses the same route when the plugin itself is disabled', async () => {
		const t = convexTest(schema, modules);
		await seedRampCell(t, { organizationId: ORG, ownShare: RAMP_FIXTURE_SHARE, cleanStreak: 3 });
		await grantPlugin(t, { isFlagEnabled: false, isGranted: true });
		configurePlugin();

		await expect(
			t.withIdentity(IDENTITY).mutation(api.providerRoutes.setRoute, pluginRoute())
		).rejects.toThrow();
		expect(await t.run(async (ctx) => await configuredRelayKinds(ctx))).toEqual([]);
	});

	// And on the axis every tier shares: a granted plugin whose declared variables
	// the deployment never set is not a transport a route may name.
	it('refuses the same route when the declared credentials are unset', async () => {
		const t = convexTest(schema, modules);
		await seedRampCell(t, { organizationId: ORG, ownShare: RAMP_FIXTURE_SHARE, cleanStreak: 3 });
		await grantPlugin(t, { isFlagEnabled: true, isGranted: true });

		await expect(
			t.withIdentity(IDENTITY).mutation(api.providerRoutes.setRoute, pluginRoute())
		).rejects.toThrow();
	});
});
