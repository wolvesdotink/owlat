/**
 * GATE 5 HAS A PRODUCTION SUPPLIER — end to end, through the REAL loader.
 *
 * The gate's own suites hand it sweeps, so every one of them stayed green while
 * `ownSeeds` and `referenceSeeds` were set by nothing outside a fixture: the
 * controller omitted both and the dashboard hardcoded `null`, so
 * `evaluateSeedGate` took the absent arm on every cell of every deployment and
 * returned `insufficient_data` forever. A gate that cannot reach a verdict is
 * not a tripwire, it is a widget — and because seed placement is optional,
 * nothing anywhere failed to say so.
 *
 * So this file asserts REACHABILITY, not arithmetic: rows go into the probe
 * ledger the way the poller writes them, and the verdict is read off the
 * evaluation the CRON'S OWN loader builds and off the screen's query — never off
 * a hand-built input. The absent case is pinned beside the seeded one, because
 * "always holds" is exactly what this file exists to detect.
 */

import { convexTest } from 'convex-test';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../schema';
import { api } from '../../_generated/api';
import type { DeliverabilityCell } from '@owlat/shared/deliverabilityRouting';
import {
	insertSeedProbes,
	type SeedProbeOptions,
} from '../../analytics/__tests__/seedProbeFixtures';
import { loadCellInput } from '../rampControllerInputs';
import { loadRampDeploymentPresence } from '../rampIntegrationPresence';
import { loadRampPresets } from '../rampPresets';
import { loadRampCapacityContext } from '../rampCapacityInputs';
import { loadStreamlessRouteState } from '../../lib/deliverabilityRouteState';
import { summarizeSeedPlacementSweeps } from '../../analytics/seedPlacement';
import type { DeliverabilityDashboard } from '../deliverabilityDashboard';
import type { DashboardCellView } from '../deliverabilityDashboardView';
import type { RampGateEvaluation, RampGateResult } from '../ramp/gateTypes';
import {
	connectRelay,
	connectTwoRelays,
	seedArmOutcomes,
	seedRampCell,
	type Harness,
} from './rampCronFixtures';
import { modules } from '../../__tests__/testModules';

const ORG = 'org_seed_gate_wiring';
const HOUR_MS = 60 * 60 * 1000;
const CELL: DeliverabilityCell = { stream: 'campaign', destinationProvider: 'gmail' };

vi.mock('../../lib/sessionOrganization', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/sessionOrganization')>();
	return {
		...actual,
		requireOrgMember: vi.fn(async () => ({
			userId: 'user-1',
			role: 'owner' as const,
			activeOrganizationId: 'org_seed_gate_wiring',
		})),
		getUserIdFromSession: vi.fn().mockResolvedValue('user-1'),
		getSingletonOrganizationId: vi.fn().mockResolvedValue('org_seed_gate_wiring'),
	};
});

async function seedProbes(
	t: Harness,
	options: Omit<SeedProbeOptions, 'organizationId'>
): Promise<void> {
	await insertSeedProbes(t, { organizationId: ORG, ...options });
}

/** The WHOLE evaluation as the CRON's loader builds it, for one cell. */
async function controllerEvaluation(
	t: Harness,
	cell: DeliverabilityCell = CELL
): Promise<RampGateEvaluation> {
	return await t.run(async (ctx) => {
		const now = Date.now();
		const pool = await loadStreamlessRouteState(ctx, ORG, 'all');
		const presence = await loadRampDeploymentPresence(ctx, { organizationId: ORG, now });
		const presets = await loadRampPresets(ctx, ORG);
		const loaded = await loadCellInput(ctx, {
			organizationId: ORG,
			cell,
			pool,
			capacity: async () => await loadRampCapacityContext(ctx, { organizationId: ORG, now }),
			seeds: async () => await summarizeSeedPlacementSweeps(ctx.db, ORG, now),
			presence,
			isKillSwitchEngaged: false,
			isSendingPermitted: true,
			presets: presets.presets,
			presetFallback: presets.fallback,
			now,
		});
		if (loaded === null) throw new Error('the seeded cell is not ramp-managed');
		const evaluation = loaded.input.evaluation;
		if (evaluation === null) throw new Error('the loader built no gate evaluation');
		return evaluation;
	});
}

/** Gate 5's verdict as the CRON's loader builds it, for the campaign/gmail cell. */
async function controllerSeedGate(
	t: Harness,
	cell: DeliverabilityCell = CELL
): Promise<RampGateResult> {
	return seedGateOf((await controllerEvaluation(t, cell)).perGate, 'the controller evaluation');
}

/** The whole screen, as the query answers it. */
async function dashboardOf(t: Harness): Promise<DeliverabilityDashboard> {
	return await t.query(api.delivery.deliverabilityDashboard.getDeliverabilityDashboard, {});
}

/** The SAME cell as the screen renders it. */
async function dashboardCellView(
	t: Harness,
	cell: DeliverabilityCell = CELL
): Promise<DashboardCellView> {
	const dashboard = await dashboardOf(t);
	const view = dashboard.cells.find(
		(candidate) =>
			candidate.cell.stream === cell.stream &&
			candidate.cell.destinationProvider === cell.destinationProvider
	);
	if (view === undefined) throw new Error('the dashboard rendered no such cell');
	return view;
}

/** The SAME verdict as the screen reports it, for the same cell. */
async function dashboardSeedGate(
	t: Harness,
	cell: DeliverabilityCell = CELL
): Promise<RampGateResult> {
	return seedGateOf((await dashboardCellView(t, cell)).gates, 'the dashboard cell');
}

function seedGateOf(gates: readonly RampGateResult[], source: string): RampGateResult {
	const gate = gates.find((result) => result.gate === 'seed_placement');
	if (gate === undefined) throw new Error(`${source} carries no seed gate`);
	return gate;
}

async function standaloneCell(t: Harness): Promise<void> {
	await seedRampCell(t, { organizationId: ORG });
	// Own traffic only: a standalone deployment, so the trailing-baseline twin
	// runs and gate 5's absolute clause is the whole gate.
	await seedArmOutcomes(t, { organizationId: ORG, arm: 'own', sent: 800 });
}

describe('a seeded placement window reaches gate 5 through the real loader', () => {
	it('reaches a PASS — a verdict, not the forever-hold', async () => {
		const t = convexTest(schema, modules);
		await standaloneCell(t);
		await seedProbes(t, { count: 20, placement: 'inbox' });

		const gate = await controllerSeedGate(t);
		expect(gate.status).toBe('pass');
		expect(gate.reason).toBe('within_threshold');
		expect(gate.measurement.ownSample).toBe(20);
	});

	it('denominates the sample in PROBES, not in connected mailboxes', async () => {
		// THE UNIT THE COPY RENDERS. `ownSample` is `SeedProviderRollup.sampleSize`,
		// summed out of per-placement PROBE counts, and the shadow copy writes one
		// probe per seed mailbox per send — so one mailbox swept over twenty sends
		// is a sample of twenty, not of one. The renderer's noun is pinned in
		// `apps/web/.../deliverabilityMeasurement.test.ts`; this is the fact it
		// renders, asserted where the number is produced.
		const t = convexTest(schema, modules);
		await standaloneCell(t);
		await seedProbes(t, { count: 20, placement: 'inbox' });

		const mailboxes = await t.run(
			async (ctx) => await ctx.db.query('externalMailAccounts').collect()
		);
		expect(mailboxes).toHaveLength(1);
		const gate = await controllerSeedGate(t);
		expect(gate.measurement.ownSample).toBe(20);
	});

	it('reaches a FAIL when the cell is being filed to spam', async () => {
		const t = convexTest(schema, modules);
		await standaloneCell(t);
		await seedProbes(t, { count: 4, placement: 'inbox' });
		await seedProbes(t, { count: 16, placement: 'spam' });

		const gate = await controllerSeedGate(t);
		expect(gate.status).toBe('fail');
		expect(gate.reason).toBe('absolute_threshold_breached');
		expect(gate.measurement.ownSample).toBe(20);
	});

	it('decides on a sweep one probe keeps fresh — the window, not a snapshot', async () => {
		// The counterpart of the stale hold below. A sweep counts the whole 7-day
		// placement window and is judged current by its NEWEST classification, so
		// one probe from an hour ago carries nineteen six-day-old ones past the 48h
		// staleness cascade and the gate decides a FAIL on all twenty. Pinned
		// because gate 5 could not reach any verdict before this wiring: this is the
		// first time the freshness rule decides something the controller acts on.
		const t = convexTest(schema, modules);
		await standaloneCell(t);
		await seedProbes(t, { count: 19, placement: 'spam', classifiedAgoMs: 6 * 24 * HOUR_MS });
		await seedProbes(t, { count: 1, placement: 'inbox' });

		const gate = await controllerSeedGate(t);
		expect(gate.status).toBe('fail');
		expect(gate.reason).toBe('absolute_threshold_breached');
		expect(gate.measurement.ownSample).toBe(20);
	});

	it('carries the WHOLE placement vocabulary across the boundary', async () => {
		// A Gmail tab is REACHED (`isSeedPlacementReached`). A wiring that folded
		// five placements into the three the gate branches on would drop these
		// probes entirely and hold on an empty sample — the same silence this file
		// exists to detect, one layer down.
		const t = convexTest(schema, modules);
		await standaloneCell(t);
		await seedProbes(t, { count: 20, placement: 'category' });

		const gate = await controllerSeedGate(t);
		expect(gate.status).toBe('pass');
		expect(gate.measurement.ownSample).toBe(20);
	});

	it('feeds the REFERENCE sweep too, so gate 5 second clause can breach', async () => {
		const t = convexTest(schema, modules);
		await seedRampCell(t, { organizationId: ORG });
		// Both arms carrying traffic: the reference-arm evaluator runs, which is
		// the only configuration in which `referenceSeeds` is consulted at all.
		await seedArmOutcomes(t, { organizationId: ORG, arm: 'own', sent: 800 });
		await seedArmOutcomes(t, { organizationId: ORG, arm: 'reference', sent: 800 });
		await seedProbes(t, { count: 18, placement: 'inbox' });
		await seedProbes(t, { count: 2, placement: 'spam' });
		await seedProbes(t, { count: 20, placement: 'inbox', arm: 'reference' });

		const gate = await controllerSeedGate(t);
		expect(gate.status).toBe('fail');
		expect(gate.reason).toBe('reference_tolerance_breached');
		expect(gate.measurement.referenceSample).toBe(20);
	});
});

describe('absence stays absent — the gate holds and says why', () => {
	it('holds with no probes at all', async () => {
		const t = convexTest(schema, modules);
		await standaloneCell(t);

		const gate = await controllerSeedGate(t);
		expect(gate.status).toBe('insufficient_data');
		expect(gate.reason).toBe('evidence_absent');
		expect(gate.measurement.ownSample).toBe(0);
	});

	it('holds on probes the poller has not classified yet', async () => {
		const t = convexTest(schema, modules);
		await standaloneCell(t);
		await seedProbes(t, { count: 20, placement: 'inbox', unclassified: true });

		expect((await controllerSeedGate(t)).status).toBe('insufficient_data');
	});

	it('holds on a sweep older than the ramp will act on', async () => {
		const t = convexTest(schema, modules);
		await standaloneCell(t);
		// Inside the 7-day placement window, outside the 48h the ramp will raise a
		// share on: the freshness cascade is the RAMP's rule, and it still applies
		// to evidence that arrives through this new path.
		await seedProbes(t, { count: 20, placement: 'inbox', classifiedAgoMs: 72 * HOUR_MS });

		const gate = await controllerSeedGate(t);
		expect(gate.status).toBe('insufficient_data');
		expect(gate.reason).toBe('own_evidence_stale');
	});

	it('does not lend one cell another cell probes', async () => {
		const t = convexTest(schema, modules);
		await standaloneCell(t);
		// A healthy sweep on a DIFFERENT destination provider. Pooling it into the
		// gmail cell would be a verdict about mailboxes this cell never touched —
		// and a sweep that only ever reached the org-wide roll-up would do exactly
		// that. The yahoo cell is read off the screen, which renders the whole grid
		// rather than only the cells the controller manages.
		await seedProbes(t, { count: 20, placement: 'inbox', provider: 'yahoo' });

		expect((await controllerSeedGate(t)).status).toBe('insufficient_data');
		expect((await dashboardSeedGate(t)).status).toBe('insufficient_data');
		expect(
			(await dashboardSeedGate(t, { stream: 'campaign', destinationProvider: 'yahoo' })).status
		).toBe('pass');
	});

	it('does not lend a cell the probes of another STREAM', async () => {
		const t = convexTest(schema, modules);
		await standaloneCell(t);
		// Every probe the shadow copy writes today is a CAMPAIGN probe, so the
		// transactional and automation cells of the same provider have no seed
		// evidence at all. That is a hold, not a borrowed verdict.
		await seedProbes(t, { count: 20, placement: 'inbox' });

		expect((await dashboardSeedGate(t)).status).toBe('pass');
		expect(
			(await dashboardSeedGate(t, { stream: 'transactional', destinationProvider: 'gmail' })).status
		).toBe('insufficient_data');
	});
});

describe('the screen reports the verdict the controller reached (ADR-0042)', () => {
	it('renders the seeded PASS rather than a hardcoded hold', async () => {
		const t = convexTest(schema, modules);
		await standaloneCell(t);
		await seedProbes(t, { count: 20, placement: 'inbox' });

		const dashboard = await dashboardSeedGate(t);
		expect(dashboard.status).toBe('pass');
		expect(dashboard.measurement.ownSample).toBe(20);
	});

	it('renders the seeded FAIL, and agrees with the controller on it', async () => {
		const t = convexTest(schema, modules);
		await standaloneCell(t);
		await seedProbes(t, { count: 4, placement: 'inbox' });
		await seedProbes(t, { count: 16, placement: 'spam' });

		const dashboard = await dashboardSeedGate(t);
		const controller = await controllerSeedGate(t);
		expect(dashboard.status).toBe('fail');
		expect(dashboard.status).toBe(controller.status);
		expect(dashboard.reason).toBe(controller.reason);
		expect(dashboard.measurement.ownSample).toBe(controller.measurement.ownSample);
	});

	it('still holds on a deployment with no seed mailboxes', async () => {
		const t = convexTest(schema, modules);
		await standaloneCell(t);

		expect((await dashboardSeedGate(t)).status).toBe('insufficient_data');
	});
});

/**
 * AGREEMENT WHERE IT IS NOT TRUE BY CONSTRUCTION.
 *
 * The describe above only ever seeds a STANDALONE cell, where both readers run
 * the trailing-baseline twin whatever predicate they choose it by — so it
 * asserts agreement in the one configuration that cannot disagree. These are the
 * configurations where the two predicates genuinely part company:
 *
 *   - TWO RELAYS — no single arm to NAME, so the configuration reading says
 *     "standalone" while every cell is measured against a relay.
 *   - A RELAY THAT WENT QUIET, at every distance from now the two spans can
 *     disagree over. The predicate is one rule, but the screen summarizes SEVEN
 *     days where the controller summarizes ONE, so a rule asked over each
 *     reader's own window still parts company — just later. That is why the case
 *     is a matrix over the relay's last sending day rather than one fixture.
 *   - A RELAY CONFIGURED BUT SILENT — a single arm to name, and no measurement
 *     to compare against, which is the same divergence pointing the other way.
 *
 * Every case is pinned on the FULL verdict, not only on gate 5: the defect this
 * repairs was a screen telling an operator a cell passes while the ramp held it
 * on `awaiting_corroboration` off the same rows.
 *
 * THE TREND IS PINNED HERE TOO, because it is the same predicate asked of a
 * third row set: the chart's own. A quiet relay's history is what EXPLAINS the
 * absent arm, so the two must not be answered by one boolean.
 */
describe('the screen picks the evaluator the controller picked (ADR-0042)', () => {
	/**
	 * Own 90% inbox against a spotless reference arm: gate 5's SECOND clause.
	 *
	 * `relayLastSentDaysAgo` moves ONLY the relay's outcome row. The own arm, the
	 * probes and the route state stay where they are, so the single variable
	 * across the matrix below is how long ago the relay last carried the cell.
	 */
	async function twoArmedBreach(t: Harness, relayLastSentDaysAgo = 0): Promise<void> {
		await seedRampCell(t, { organizationId: ORG });
		await seedArmOutcomes(t, { organizationId: ORG, arm: 'own', sent: 800 });
		await seedArmOutcomes(t, {
			organizationId: ORG,
			arm: 'reference',
			sent: 800,
			dayOffset: relayLastSentDaysAgo,
		});
		await seedProbes(t, { count: 18, placement: 'inbox' });
		await seedProbes(t, { count: 2, placement: 'spam' });
		await seedProbes(t, { count: 20, placement: 'inbox', arm: 'reference' });
	}

	it('agrees on a two-relay deployment, which has no arm to name', async () => {
		const t = convexTest(schema, modules);
		await connectTwoRelays(t);
		await twoArmedBreach(t);

		// THE PREMISE OF THIS CASE, asserted rather than assumed: two relay kinds
		// leave `referenceRelayTransportId` with no single arm to name. Without
		// this, a change to `configuredRelayKinds` would quietly turn the flagship
		// case into an ordinary single-relay one that passes for the wrong reason.
		expect((await dashboardOf(t)).referenceTransportId).toBeNull();

		const controller = await controllerEvaluation(t);
		const view = await dashboardCellView(t);
		// The reference-arm evaluator's verdict, on BOTH sides. The screen used to
		// choose its evaluator from "is there exactly one relay kind configured",
		// come out standalone here, and report pass/within_threshold beside a ramp
		// holding the cell.
		expect(seedGateOf(controller.perGate, 'controller')).toMatchObject({
			status: 'fail',
			reason: 'reference_tolerance_breached',
		});
		expect(seedGateOf(view.gates, 'dashboard')).toMatchObject({
			status: 'fail',
			reason: 'reference_tolerance_breached',
		});
		expect(view.verdict).toBe(controller.verdict);
		// The GATE BY NAME on both sides. `controller.failedGate ?? null` would be
		// satisfied by an undefined against a null — the exact class of mismatch
		// this assertion exists to catch.
		expect(controller.failedGate).toBe('seed_placement');
		expect(view.failedGate).toBe('seed_placement');
		// The measured arm reaches the screen as an arm, not as a null: the
		// evaluator choice and the column beside it are one fact.
		expect(view.reference?.sent).toBe(800);
	});

	/**
	 * The relay's last sending day, swept from today out past the far edge of the
	 * screen's window. Day 0 and day 1 are inside the controller's span (its 24h
	 * `since` floors to a UTC day start, so yesterday's bucket still counts); days
	 * 2..6 are outside it and INSIDE the screen's seven days — the band where a
	 * predicate asked over each reader's own window still put one cell on two
	 * evaluators; day 7 is outside both.
	 */
	const RELAY_LAST_SENT_OFFSETS = [0, 1, 2, 3, 4, 5, 6, 7] as const;
	const CONTROLLER_ARM_SPAN_DAYS = 1;

	describe.each(RELAY_LAST_SENT_OFFSETS)(
		'the relay last sent %i day(s) ago',
		(relayLastSentDaysAgo) => {
			it('reaches the same verdict on the screen as in the controller', async () => {
				const t = convexTest(schema, modules);
				// No route row at all — the operator disabled the relay — while the
				// rows it carried are still in the tables both readers read.
				await twoArmedBreach(t, relayLastSentDaysAgo);

				const controller = await controllerEvaluation(t);
				const view = await dashboardCellView(t);
				expect(view.verdict).toBe(controller.verdict);
				expect(view.failedGate ?? null).toBe(controller.failedGate ?? null);
				expect(seedGateOf(view.gates, 'dashboard')).toMatchObject(
					seedGateOf(controller.perGate, 'controller')
				);
			});

			it('shows the arm exactly while the controller is judging one', async () => {
				const t = convexTest(schema, modules);
				await twoArmedBreach(t, relayLastSentDaysAgo);

				const view = await dashboardCellView(t);
				// Which evaluator ran is legible from gate 5's reason: only the
				// two-armed one can breach the reference tolerance.
				const stillMeasured = relayLastSentDaysAgo <= CONTROLLER_ARM_SPAN_DAYS;
				expect(view.reference === null).toBe(!stillMeasured);
				expect(seedGateOf(view.gates, 'dashboard').reason).toBe(
					stillMeasured ? 'reference_tolerance_breached' : 'within_threshold'
				);
			});
		}
	);

	it('keeps plotting the days the relay did carry after the arm has gone quiet', async () => {
		const t = convexTest(schema, modules);
		// Three days ago: outside the span the evaluator asks about, inside the
		// seven days the chart plots. The trend's predicate belongs to the trend's
		// own rows, so dropping the series here would erase the very history that
		// explains why the arm is gone.
		await twoArmedBreach(t, 3);

		const view = await dashboardCellView(t);
		expect(view.reference).toBeNull();
		expect(view.trend.every((point) => point.reference !== null)).toBe(true);
		expect(view.trend.filter((point) => (point.reference?.sent ?? 0) > 0)).toHaveLength(1);
	});

	it('plots no relay series at all for a cell no relay ever carried', async () => {
		const t = convexTest(schema, modules);
		// The other side of the same predicate: a flat line of zeros beside the own
		// series reads as a relay sending nothing, which is not what happened.
		await connectRelay(t);
		await standaloneCell(t);

		const view = await dashboardCellView(t);
		expect(view.trend.length).toBeGreaterThan(0);
		expect(view.trend.every((point) => point.reference === null)).toBe(true);
	});

	it('agrees when a configured relay carried nothing — the arm is absent, not empty', async () => {
		const t = convexTest(schema, modules);
		// The divergence in the other direction: one relay kind IS configured, so
		// the screen used to hand the two-armed evaluator a reference arm of zeros
		// while the controller nulled it out and ran the standalone twin.
		await connectRelay(t);
		await standaloneCell(t);
		await seedProbes(t, { count: 18, placement: 'inbox' });
		await seedProbes(t, { count: 2, placement: 'spam' });

		const controller = await controllerEvaluation(t);
		const view = await dashboardCellView(t);
		expect(seedGateOf(view.gates, 'dashboard')).toMatchObject(
			seedGateOf(controller.perGate, 'controller')
		);
		expect(view.verdict).toBe(controller.verdict);
		expect(view.reference).toBeNull();
		// A cell nothing was measured against is not high-confidence direct
		// measurement, however the relay list reads.
		expect(view.confidence.level).not.toBe('high');
		expect(view.confidence.improvements).toContain('connect_reference_transport');
	});

	it('grades on the constants the TABLE tightened, not the shipped ones', async () => {
		const t = convexTest(schema, modules);
		// No feedback loop anywhere in this deployment, so the fold halves the
		// complaint ceiling to 0.05%. Both arms complain at 0.075%: inside the
		// shipped 0.1% and outside the tightened line, and identical on both arms
		// so the tolerance clause decides nothing. The screen used to grade this
		// cell against the shipped ceiling and call it a pass while the cron
		// failed it.
		await seedRampCell(t, { organizationId: ORG });
		for (const arm of ['own', 'reference'] as const) {
			await seedArmOutcomes(t, {
				organizationId: ORG,
				arm,
				sent: 4000,
				counters: { delivered: 4000, complained: 3 },
			});
		}

		const controller = await controllerEvaluation(t);
		const view = await dashboardCellView(t);
		const complaintOf = (gates: readonly RampGateResult[]): RampGateResult => {
			const gate = gates.find((result) => result.gate === 'complaint');
			if (gate === undefined) throw new Error('no complaint gate');
			return gate;
		};
		expect(complaintOf(controller.perGate).status).toBe('fail');
		expect(complaintOf(view.gates)).toMatchObject(complaintOf(controller.perGate));
		expect(view.verdict).toBe(controller.verdict);
	});

	it('gives the screen the standalone evaluator SUBSTITUTION inputs too (#503)', async () => {
		const t = convexTest(schema, modules);
		// A standalone cell whose hard-bounce rate is inside the absolute ceiling
		// but 3x its own trailing baseline: the trailing twin's RELATIVE clause,
		// which needs `ownTrailingBaseline`. A screen that omitted it graded the
		// window on the absolute clause alone and called the cell healthy.
		await seedRampCell(t, { organizationId: ORG });
		await seedArmOutcomes(t, {
			organizationId: ORG,
			arm: 'own',
			sent: 2000,
			dayOffset: 10,
			counters: { delivered: 1998, hardBounced: 2 },
		});
		await seedArmOutcomes(t, {
			organizationId: ORG,
			arm: 'own',
			sent: 2000,
			counters: { delivered: 1980, hardBounced: 20 },
		});

		const controller = await controllerEvaluation(t);
		const view = await dashboardCellView(t);
		const gateOf = (gates: readonly RampGateResult[]): RampGateResult => {
			const gate = gates.find((result) => result.gate === 'hard_bounce');
			if (gate === undefined) throw new Error('no hard-bounce gate');
			return gate;
		};
		expect(gateOf(controller.perGate).status).toBe('fail');
		expect(gateOf(view.gates)).toMatchObject(gateOf(controller.perGate));
		expect(view.verdict).toBe(controller.verdict);
	});
});
