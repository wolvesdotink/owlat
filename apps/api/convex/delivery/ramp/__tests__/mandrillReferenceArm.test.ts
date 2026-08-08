/**
 * ARM ATTRIBUTION WITH MANDRILL AS THE REFERENCE ARM (Mandrill plan D8/D10,
 * piece P2.3) — the measurement plane's core promise, at the cron boundary.
 *
 * The whole migration story rests on one claim: while the ramp controller walks
 * traffic from Mandrill onto Owlat's own MTA, each arm is judged on ITS OWN
 * numbers. If Mandrill's bounces, complaints or deferrals leaked into the own
 * arm's counters, a migrating deployment would watch its ramp freeze and
 * retreat because of mail OWLAT NEVER SENT — and the operator would have no way
 * to tell that from a genuinely unhealthy MTA. The converse leak is worse: own
 * -arm damage credited to the reference arm would let a failing MTA keep
 * climbing on a relay's good name.
 *
 * Nothing here invents controller behaviour. Attribution is decided once, at
 * assignment time (`armForTransport`: the own MTA is `own`, EVERY other
 * transport kind is `reference`), and the outcome recorder reads the stored
 * `arm` column rather than re-deriving it — so 'mandrill' is `reference` by the
 * same rule 'ses' is. What this suite pins is that the rule actually holds
 * end-to-end for a Mandrill cell: through the real relay-deferral writer, and
 * through the real hourly tick.
 *
 * Fixtures come from the shared cron harness (`rampCronFixtures`), with the
 * relay kind named `mandrill` so the CONFIGURATION says what the counters do.
 */

import { convexTest } from 'convex-test';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { loadStreamlessRouteState } from '../../../lib/deliverabilityRouteState';
import { summarizeSeedPlacementSweeps } from '../../../analytics/seedPlacement';
import { loadRampCapacityContext } from '../../rampCapacityInputs';
import { loadCellInput } from '../../rampControllerInputs';
import { loadRampDeploymentPresence } from '../../rampIntegrationPresence';
import { loadRampPresets } from '../../rampPresets';
import { configuredRelayKinds } from '../../relayConfiguration';
import {
	connectRelay,
	readManagedCell,
	seedArmOutcomes,
	seedGreenWindows,
	seedRampCell,
	type Harness,
} from '../../__tests__/rampCronFixtures';

const ORG = 'org_mandrill_reference_arm';

vi.mock('../../../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../lib/sessionOrganization')>();
	return {
		...actual,
		getSingletonOrganizationId: vi.fn().mockResolvedValue('org_mandrill_reference_arm'),
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
 * A DEPLOYMENT MID-MIGRATION: half the cell's traffic still going through
 * Mandrill, a healthy history on both arms, and Mandrill named as the relay in
 * `providerRoutes` under the one strategy that splits by the cell's share.
 */
async function seedMandrillMigration(t: Harness): Promise<void> {
	// The relay is expressed through the route row, never through an ambient
	// single-transport env that would hand the fixture a sender it never named.
	vi.stubEnv('EMAIL_PROVIDER', 'mta');
	await seedRampCell(t, { organizationId: ORG, ownShare: MID_RAMP_SHARE, cleanStreak: 3 });
	await connectRelay(t, 'adaptive_mix', 'mandrill');
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
 * and the cell off. `transport` is the provider kind, so this is where
 * 'mandrill' actually appears in the measurement plane.
 */
async function seedAssignedMandrillSend(
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

/** The substitution table's resolution for this cell, read the way the cron reads it. */
async function degradationFor(t: Harness) {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const presets = await loadRampPresets(ctx, ORG);
		const loaded = await loadCellInput(ctx, {
			organizationId: ORG,
			cell: CELL,
			pool: await loadStreamlessRouteState(ctx, ORG, 'all'),
			capacity: async () => await loadRampCapacityContext(ctx, { organizationId: ORG, now }),
			seeds: async () => await summarizeSeedPlacementSweeps(ctx.db, ORG, now),
			presence: await loadRampDeploymentPresence(ctx, { organizationId: ORG, now }),
			isKillSwitchEngaged: false,
			isSendingPermitted: true,
			presets: presets.presets,
			presetFallback: presets.fallback,
			now,
		});
		if (loaded === null) throw new Error('the seeded cell is not ramp-managed');
		return loaded.degradation;
	});
}

describe('Mandrill is the reference arm by configuration and by attribution', () => {
	// The premise of every case below, stated rather than assumed: a stray route
	// row or an ambient env would otherwise leave a "Mandrill" suite measuring SES.
	it('is discovered as the deployment relay kind', async () => {
		const t = convexTest(schema, modules);
		await seedMandrillMigration(t);

		expect(await t.run(async (ctx) => await configuredRelayKinds(ctx))).toEqual(['mandrill']);
	});

	// Attribution is kind-agnostic: the assignment writer asks only whether the
	// transport is the own MTA, so a Mandrill send is `reference` for exactly the
	// reason an SES send is — and the recorder never re-derives it from the kind.
	it('lands a Mandrill relay deferral on the reference arm, not the own arm', async () => {
		const t = convexTest(schema, modules);
		await seedMandrillMigration(t);
		await seedAssignedMandrillSend(t, {
			providerMessageId: 'mandrill-msg-deferred',
			transport: 'mandrill',
			arm: 'reference',
		});
		const before = { own: await armTotals(t, 'own'), reference: await armTotals(t, 'reference') };

		// The exact mutation `DISPATCH['email.deferred']` runs for a Mandrill
		// `deferral` webhook (P2.1's relay-deferral writer).
		const result = await t.mutation(internal.delivery.deferralOutcome.recordRelayDeferral, {
			providerMessageId: 'mandrill-msg-deferred',
			at: Date.now(),
		});
		await drainOutcomeWrites(t);

		expect(result).toBe('observed');
		expect((await armTotals(t, 'reference')).deferred).toBe(before.reference.deferred + 1);
		// THE POINT: gate 2 divides the OWN arm's deferrals, and a relay holding its
		// own mail must never enter that numerator.
		expect((await armTotals(t, 'own')).deferred).toBe(before.own.deferred);
	});

	// THE CONTROL for the case above — the same writer, the same cell, the only
	// difference being which arm the assignment names. Without it, "landed on the
	// reference arm" could equally mean "landed nowhere the own arm could see".
	it('lands an own-MTA deferral on the own arm', async () => {
		const t = convexTest(schema, modules);
		await seedMandrillMigration(t);
		await seedAssignedMandrillSend(t, {
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

describe('a burst on the Mandrill arm does not move the own arm', () => {
	// THE CONTROL, and it has to be an INCREASE rather than a hold: a case below
	// asserting "the reference burst did not stop the ramp" says nothing at all if
	// this deployment was not ramping in the first place.
	it('climbs on a clean deployment', async () => {
		const t = convexTest(schema, modules);
		await seedMandrillMigration(t);

		await runTick(t);

		const row = await readManagedCell(t);
		expect(row?.ownShare).toBeGreaterThan(MID_RAMP_SHARE);
		expect(row?.frozenUntil).toBeUndefined();
		expect(await decision(t)).toMatchObject({ direction: 'increase', verdict: 'pass' });
	});

	// The migration's day-1 fear, in one fixture: Mandrill has a terrible day —
	// hard bounces, complaints and deferrals all at once, on mail Owlat's MTA
	// never touched. The own arm's share must not pay for it.
	it('neither freezes nor decreases the own share on a reference-arm burst', async () => {
		const t = convexTest(schema, modules);
		await seedMandrillMigration(t);
		await seedArmOutcomes(t, { organizationId: ORG, arm: 'reference', ...BURST });

		await runTick(t);

		const row = await readManagedCell(t);
		// The SAME decision the control took, not merely "not a retreat": the ramp
		// carries on climbing as though the relay's bad day had not happened,
		// because for the own arm it did not.
		expect(row?.ownShare).toBeGreaterThan(MID_RAMP_SHARE);
		expect(row?.frozenUntil).toBeUndefined();
		expect(row?.freezeReason).toBeUndefined();
		const audited = await decision(t);
		// No own-arm gate broke, because no own-arm number changed.
		expect(audited).toMatchObject({ direction: 'increase', verdict: 'pass' });
		expect(audited?.failedGate).toBeUndefined();
	});

	// A relay that holds mail it already accepted is the reference arm's problem
	// to have. Gate 2 reads the own arm only, and this pins that it stays that way
	// with Mandrill's deferrals — the one signal the relay produces most of.
	it('does not trip the deferral gate on reference-arm deferrals alone', async () => {
		const t = convexTest(schema, modules);
		await seedMandrillMigration(t);
		await seedArmOutcomes(t, {
			organizationId: ORG,
			arm: 'reference',
			sent: 5_000,
			counters: { delivered: 1_000, deferred: 4_000 },
		});

		await runTick(t);

		expect((await decision(t))?.failedGate).not.toBe('deferral');
		expect((await readManagedCell(t))?.ownShare).toBeGreaterThan(MID_RAMP_SHARE);
	});
});

describe('a burst on the own arm retreats, and leaves Mandrill alone', () => {
	it('freezes and decreases the own share, naming the own-arm gate', async () => {
		const t = convexTest(schema, modules);
		await seedMandrillMigration(t);
		await seedArmOutcomes(t, { organizationId: ORG, arm: 'own', ...BURST });

		await runTick(t);

		const row = await readManagedCell(t);
		expect(row?.ownShare).toBeLessThan(MID_RAMP_SHARE);
		expect(row?.frozenUntil).toBeGreaterThan(Date.now());
		expect(row?.freezeReason).toBe('gate_breach');
		// The gate that broke is named, and it is the OWN arm's hard-bounce
		// ceiling — the one instrument that actually changed.
		expect(await decision(t)).toMatchObject({ direction: 'decrease', failedGate: 'hard_bounce' });
	});

	// THE OTHER HALF OF THE PROMISE. A retreat is a decision about the OWN arm,
	// and the tick must not touch the reference arm's evidence on its way past —
	// the relay's counters are the comparison series the next tick reads.
	it('leaves every reference-arm counter exactly as it found it', async () => {
		const t = convexTest(schema, modules);
		await seedMandrillMigration(t);
		await seedArmOutcomes(t, { organizationId: ORG, arm: 'own', ...BURST });
		const before = await armTotals(t, 'reference');

		await runTick(t);
		await drainOutcomeWrites(t);

		expect(await armTotals(t, 'reference')).toEqual(before);
	});
});

describe('reference-arm PRESENCE is what the substitution table reads (shipped semantics)', () => {
	// PINNED, NOT INVENTED. The table asks whether a reference arm SENT anything
	// in the window — never whether it is healthy. A Mandrill arm having its worst
	// day is still a measured second sender, so the reference-arm evaluator keeps
	// running and its bad numbers stay in the comparison rather than degrading the
	// cell to the standalone twin.
	it('keeps the reference-arm evaluator for a sick but busy Mandrill arm', async () => {
		const t = convexTest(schema, modules);
		await seedMandrillMigration(t);
		await seedArmOutcomes(t, { organizationId: ORG, arm: 'reference', ...BURST });

		const degradation = await degradationFor(t);
		expect(degradation.actuator).toBe('share');
		expect(degradation.absent.map((entry) => entry.integration)).not.toContain(
			'reference_transport'
		);
	});

	// The counter-case, and the only thing that flips it: a relay that goes SILENT
	// is an absent reference arm, whatever `providerRoutes` still says. Same
	// shipped substitution as for any other kind.
	it('degrades to the standalone twin when the Mandrill arm sends nothing', async () => {
		const t = convexTest(schema, modules);
		vi.stubEnv('EMAIL_PROVIDER', 'mta');
		await seedRampCell(t, { organizationId: ORG, ownShare: MID_RAMP_SHARE, cleanStreak: 3 });
		await connectRelay(t, 'adaptive_mix', 'mandrill');
		await seedArmOutcomes(t, { organizationId: ORG, arm: 'own', sent: 5_000 });

		const degradation = await degradationFor(t);
		expect(degradation.absent.map((entry) => entry.integration)).toContain('reference_transport');
	});
});
