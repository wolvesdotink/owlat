/**
 * ARM ATTRIBUTION WITH A PLUGIN TRANSPORT AS THE REFERENCE ARM (the seams plan's
 * P3.3, its acceptance criterion A4) — the ramp half of the parity proof.
 *
 * The conformance suite (`examples/conformance/src/__tests__/pluginProviderParity.test.ts`)
 * proves everything a pure module can be asked: routing under all four
 * strategies, fallback eligibility, the return-path fold, the feedback route's
 * verification chain, the domain-identity split and the credential form. What it
 * cannot prove is the one property that only exists across a database — that a
 * plugin transport's outcomes land on the RIGHT ARM through the real relay
 * writers and the real hourly controller tick.
 *
 * That property is the whole reason the plugin tier is worth having. If a
 * plugin relay's bounces, complaints or deferrals leaked into the OWN arm's
 * counters, a deployment ramping onto its own MTA would watch the ramp freeze
 * and retreat because of mail Owlat never sent, with no way to tell that from an
 * unhealthy MTA. The converse leak is worse: own-arm damage credited to the
 * plugin arm would let a failing MTA keep climbing on a third party's good name.
 *
 * NOTHING HERE IS PLUGIN-SPECIFIC BEHAVIOUR, and that is the finding. Attribution
 * is decided once, at assignment time (`armForTransport`: the own MTA is `own`,
 * EVERY other transport kind is `reference`), and the outcome recorder reads the
 * stored `arm` column rather than re-deriving it — so `plugin.mock-esp.relay` is
 * `reference` by the same rule `'ses'` and `'mandrill'` are. This suite is the
 * standing regression harness for that: it is a near-copy of
 * `./mandrillReferenceArm.test.ts` with the relay kind changed and the composed
 * plugin catalog supplied, and it must keep passing without a line of core code
 * learning that this transport is not core.
 *
 * THE COMPOSED CATALOG IS MOCKED because `plugins.config.ts` is empty in this
 * repository (D4's wire-it-when-real policy), so the generated artifact ships as
 * an empty array. The entry below is the one the real renderer emits for the
 * conformance fixture manifest — the conformance suite asserts that equality, so
 * a renderer change fails there rather than silently diverging here.
 */

import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** The conformance fixture's transport kind. Owned by `examples/conformance/`. */
const KIND = 'plugin.mock-esp.relay';
const PLUGIN_ID = 'mock-esp';

vi.mock('../../../plugins/sendTransportCatalog.generated', () => ({
	BUNDLED_PLUGIN_SEND_TRANSPORT_CATALOG: Object.freeze([
		Object.freeze({
			kind: 'plugin.mock-esp.relay',
			pluginId: 'mock-esp',
			localId: 'relay',
			label: 'Mock ESP',
			retryDelays: Object.freeze([1_000, 5_000]),
			requiredEnvVars: Object.freeze([
				'MOCK_ESP_ENABLED',
				'PLUGIN_MOCK_ESP_WEBHOOK_SECRET',
				'PLUGIN_MOCK_ESP_TOKEN',
			]),
			optionalEnvVars: Object.freeze(['PLUGIN_MOCK_ESP_REGION']),
			instanceEnvVars: Object.freeze(['PLUGIN_MOCK_ESP_TOKEN', 'PLUGIN_MOCK_ESP_REGION']),
			supportsCustomReturnPath: 'no',
			messageIdSource: 'provider',
			hasProviderFeedback: true,
			domainVerification: 'api',
			requiredCapability: 'send:transport',
		}),
	]),
}));

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
import { internal } from '../../../_generated/api';
import type { Doc, Id } from '../../../_generated/dataModel';
import {
	createTestCampaign,
	createTestContact,
	createTestEmailSend,
} from '../../../__tests__/factories';
import { modules } from '../../../__tests__/testModules';
import { deliverabilityCellKey } from '@owlat/shared/deliverabilityRouting';
import {
	drainOutcomeWrites,
	sumCounters,
} from '../../../analytics/__tests__/transportOutcomesFixtures';
import { armForTransport } from '../../sendAssignments';
import type { SendProviderKind } from '../../../lib/sendProviders/types';
import { configuredRelayKinds } from '../../relayConfiguration';
import {
	connectRelay,
	readManagedCell,
	seedArmOutcomes,
	seedGreenWindows,
	seedRampCell,
	type Harness,
} from '../../__tests__/rampCronFixtures';

const ORG = 'org_plugin_reference_arm';

vi.mock('../../../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../lib/sessionOrganization')>();
	return {
		...actual,
		getSingletonOrganizationId: vi.fn().mockResolvedValue('org_plugin_reference_arm'),
	};
});

const CELL = { stream: 'campaign', destinationProvider: 'gmail' } as const;
const CELL_KEY = deliverabilityCellKey(CELL);

/** The mid-ramp share the migration fixtures below start from. */
const MID_RAMP_SHARE = 0.5;

/** A burst big enough to breach every ratio ceiling the gates carry. */
const BURST = {
	sent: 5_000,
	counters: { delivered: 2_000, hardBounced: 2_500, complained: 400, deferred: 2_500 },
} as const;

afterEach(() => {
	vi.unstubAllEnvs();
});

/**
 * A DEPLOYMENT MID-RAMP with a PLUGIN relay: half the cell's traffic still going
 * through `@acme/mock-esp`, a healthy history on both arms, and the plugin kind
 * named in `providerRoutes` under the one strategy that splits by the cell's
 * share.
 */
async function seedPluginMigration(t: Harness): Promise<void> {
	// The relay is expressed through the route row, never through an ambient
	// single-transport env that would hand the fixture a sender it never named.
	vi.stubEnv('EMAIL_PROVIDER', 'mta');
	await seedRampCell(t, { organizationId: ORG, ownShare: MID_RAMP_SHARE, cleanStreak: 3 });
	await connectRelay(t, 'adaptive_mix', KIND);
	await seedGreenWindows(t, { organizationId: ORG });
}

async function runTick(t: Harness): Promise<void> {
	await t.mutation(internal.delivery.rampControllerCron.runRampController, {});
}

/** The tick's decision row for the managed cell. */
async function decision(t: Harness): Promise<Doc<'mixDecisions'> | undefined> {
	const rows = await t.run(async (ctx) => await ctx.db.query('mixDecisions').collect());
	return rows.find((row) => row.cell === CELL_KEY);
}

/** Every counter of one arm, summed across shards and days. */
async function armTotals(t: Harness, arm: 'own' | 'reference') {
	return await t.run(async (ctx) => {
		const rows = await ctx.db.query('transportOutcomes').collect();
		return sumCounters(rows.filter((row) => row.cell === CELL_KEY && row.arm === arm));
	});
}

/**
 * A send WITH its assignment row — the join the outcome recorder reads the arm
 * and the cell off. `transport` is the provider kind, so this is where the
 * namespaced plugin kind actually appears in the measurement plane.
 */
async function seedAssignedSend(
	t: Harness,
	args: { providerMessageId: string; transport: string; arm: 'own' | 'reference' }
): Promise<Id<'emailSends'>> {
	return await t.run(async (ctx) => {
		const campaignId = await ctx.db.insert('campaigns', createTestCampaign());
		const contact = createTestContact();
		const contactId = await ctx.db.insert('contacts', contact);
		const sendId = await ctx.db.insert(
			'emailSends',
			createTestEmailSend({
				campaignId,
				contactId,
				contactEmail: contact.email ?? 'reference@example.com',
				status: 'sent',
				providerType: args.transport,
				providerMessageId: args.providerMessageId,
			})
		);
		await ctx.db.insert('sendAssignments', {
			organizationId: ORG,
			sendId,
			sendKind: 'campaign',
			cell: CELL_KEY,
			transport: args.transport,
			arm: args.arm,
			isCalibration: false,
			mixVersion: 2,
			assignedAt: Date.now(),
		});
		return sendId;
	});
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
			providerMessageId: 'plugin-msg-deferred',
			transport: KIND,
			arm: 'reference',
		});
		const before = { own: await armTotals(t, 'own'), reference: await armTotals(t, 'reference') };

		// The exact mutation the plugin feedback route's `email.deferred` dispatch
		// runs — the same writer a core relay's deferral webhook reaches.
		const result = await t.mutation(internal.delivery.deferralOutcome.recordRelayDeferral, {
			providerMessageId: 'plugin-msg-deferred',
			at: Date.now(),
		});
		await drainOutcomeWrites(t);

		expect(result).toBe('observed');
		expect((await armTotals(t, 'reference')).deferred).toBe(before.reference.deferred + 1);
		// THE POINT: gate 2 divides the OWN arm's deferrals, and a third party
		// holding its own mail must never enter that numerator.
		expect((await armTotals(t, 'own')).deferred).toBe(before.own.deferred);
	});

	// THE CONTROL for the case above — same writer, same cell, the only difference
	// being which arm the assignment names.
	it('lands an own-MTA deferral on the own arm', async () => {
		const t = convexTest(schema, modules);
		await seedPluginMigration(t);
		await seedAssignedSend(t, {
			providerMessageId: 'mta-msg-deferred',
			transport: 'mta',
			arm: 'own',
		});
		const before = { own: await armTotals(t, 'own'), reference: await armTotals(t, 'reference') };

		await t.mutation(internal.delivery.deferralOutcome.recordRelayDeferral, {
			providerMessageId: 'mta-msg-deferred',
			at: Date.now(),
		});
		await drainOutcomeWrites(t);

		expect((await armTotals(t, 'own')).deferred).toBe(before.own.deferred + 1);
		expect((await armTotals(t, 'reference')).deferred).toBe(before.reference.deferred);
	});
});

describe('a burst on the plugin arm does not move the own arm', () => {
	// THE CONTROL, and it has to be an INCREASE rather than a hold: a case below
	// asserting "the reference burst did not stop the ramp" says nothing at all if
	// this deployment was not ramping in the first place.
	it('climbs on a clean deployment', async () => {
		const t = convexTest(schema, modules);
		await seedPluginMigration(t);

		await runTick(t);

		const row = await readManagedCell(t);
		expect(row?.ownShare).toBeGreaterThan(MID_RAMP_SHARE);
		expect(row?.frozenUntil).toBeUndefined();
		expect(await decision(t)).toMatchObject({ direction: 'increase', verdict: 'pass' });
	});

	// The day-1 fear of every third-party relay, in one fixture: the plugin has a
	// terrible day — hard bounces, complaints and deferrals at once, on mail
	// Owlat's MTA never touched. The own arm's share must not pay for it.
	it('neither freezes nor decreases the own share on a reference-arm burst', async () => {
		const t = convexTest(schema, modules);
		await seedPluginMigration(t);
		await seedArmOutcomes(t, { organizationId: ORG, arm: 'reference', ...BURST });

		await runTick(t);

		const row = await readManagedCell(t);
		// The SAME decision the control took, not merely "not a retreat".
		expect(row?.ownShare).toBeGreaterThan(MID_RAMP_SHARE);
		expect(row?.frozenUntil).toBeUndefined();
		expect(row?.freezeReason).toBeUndefined();
		const audited = await decision(t);
		expect(audited).toMatchObject({ direction: 'increase', verdict: 'pass' });
		expect(audited?.failedGate).toBeUndefined();
	});
});

describe('a burst on the own arm retreats, and leaves the plugin arm alone', () => {
	it('freezes and decreases the own share, naming the own-arm gate', async () => {
		const t = convexTest(schema, modules);
		await seedPluginMigration(t);
		await seedArmOutcomes(t, { organizationId: ORG, arm: 'own', ...BURST });

		await runTick(t);

		const row = await readManagedCell(t);
		expect(row?.ownShare).toBeLessThan(MID_RAMP_SHARE);
		expect(row?.frozenUntil).toBeGreaterThan(Date.now());
		expect(row?.freezeReason).toBe('gate_breach');
		expect(await decision(t)).toMatchObject({ direction: 'decrease', failedGate: 'hard_bounce' });
	});

	// THE OTHER HALF OF THE PROMISE. A retreat is a decision about the OWN arm, and
	// the tick must not touch the reference arm's evidence on its way past — the
	// plugin's counters are the comparison series the next tick reads.
	it('leaves every reference-arm counter exactly as it found it', async () => {
		const t = convexTest(schema, modules);
		await seedPluginMigration(t);
		await seedArmOutcomes(t, { organizationId: ORG, arm: 'own', ...BURST });
		const before = await armTotals(t, 'reference');

		await runTick(t);
		await drainOutcomeWrites(t);

		expect(await armTotals(t, 'reference')).toEqual(before);
	});
});
