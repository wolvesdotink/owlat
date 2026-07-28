/**
 * Deliverability dashboard — the READ side (plan D2, D5, D14, D15).
 *
 * SHIP THE MEASUREMENT BEFORE THE CONTROL. This query is the human's
 * sanity-check on the gates: per cell, both arms' outcomes, every gate's
 * verdict WITH the numbers that produced it, and how much the measurement is
 * worth. It is READ-ONLY by construction — there is no mutation in this module
 * and there will not be one; P3-6 adds the control surface separately.
 *
 * SHAPE. One index read per (cell, arm) over the widest window any sub-view
 * needs (the evaluation window, the trailing baseline, the daily trend), and
 * every number derived from those rows by the ONE summarizer (ADR-0042 / D5).
 * The screen and the ramp controller therefore cannot disagree: they run the
 * same arithmetic over the same rows.
 *
 * D2. A deployment with no reference transport is a SUPPORTED CONFIGURATION,
 * not an incomplete setup. `reference` is `null` for every cell, the
 * TRAILING-BASELINE evaluator runs instead of the two-armed one — the standalone
 * implementation is the honest answer for a standalone deployment, not a
 * fallback — and `dashboardConfidence` caps the level at what the missing
 * measurement inputs allow, so the screen says "measurement confidence: low" and
 * names what would improve it (plan D14) rather than grading a column of holds
 * `high`. Nothing throws, nothing renders as an error, nothing is blocked.
 */

import {
	allDeliverabilityCells,
	deliverabilityCellKey,
	DESTINATION_PROVIDER_KEYS,
	resolveOwnShare,
	type DeliverabilityCell,
} from '@owlat/shared/deliverabilityRouting';
import type { Doc } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { authedQuery } from '../lib/authedFunctions';
import { getSingletonOrganizationId } from '../lib/sessionOrganization';
import { readCellArmBuckets } from '../analytics/transportOutcomes';
import { hasSeedAccounts } from '../analytics/seedAccounts';
import {
	summarizeTransportOutcomeBuckets,
	type TransportOutcomeBucket,
	type TransportOutcomeSummary,
} from '../analytics/transportOutcomeSummary';
import { referenceRelayTransportId } from './alignmentPreflight';
import { RAMP_STREAM_CONFIGS } from './ramp/gateConfig';
import { referenceArmGateEvaluator, trailingBaselineGateEvaluator } from './ramp/gateEvaluation';
import { evaluateEngagementGate } from './ramp/engagementGate';
import type { RampGateResult } from './ramp/gateTypes';
import {
	buildDashboardCellView,
	buildDashboardTrend,
	dashboardWindow,
	type DashboardCellView,
	type DashboardWindow,
} from './deliverabilityDashboardView';

/** Route-state rows for one provider — one per stream plus the legacy row. */
const ROUTE_STATE_SCAN_LIMIT = 16;

/**
 * The cell's route-state row: the per-stream row when the controller has
 * written one, otherwise the legacy stream-less row the MTA snapshot writes.
 * Legacy rows carry no `ownShare` and must keep working (plan D1).
 */
function pickRouteState(
	rows: readonly Doc<'deliverabilityRouteStates'>[],
	cell: DeliverabilityCell
): Doc<'deliverabilityRouteStates'> | null {
	return (
		rows.find((row) => row.stream === cell.stream) ??
		rows.find((row) => row.stream === undefined) ??
		null
	);
}

async function readRouteStatesByProvider(
	ctx: QueryCtx,
	organizationId: string
): Promise<Map<string, Doc<'deliverabilityRouteStates'>[]>> {
	const byProvider = new Map<string, Doc<'deliverabilityRouteStates'>[]>();
	// The index is provider-keyed, so the read is too: one bounded read per
	// destination provider, shared by that provider's three streams.
	for (const destinationProvider of DESTINATION_PROVIDER_KEYS) {
		const rows = await ctx.db
			.query('deliverabilityRouteStates')
			.withIndex('by_org_provider', (q) =>
				q.eq('organizationId', organizationId).eq('destinationProvider', destinationProvider)
			)
			.take(ROUTE_STATE_SCAN_LIMIT); // bounded: one row per stream, plus the legacy row
		byProvider.set(destinationProvider, rows);
	}
	return byProvider;
}

/**
 * Gate 4 (engagement) for one cell, over the same rows every other view uses.
 * `ownPriorBaseline` is the trailing window the slow-poison floor contracts for,
 * and `dashboardWindow` guarantees it ENDS where the evaluation window begins —
 * a baseline that overlapped the recent window would be dragged down by the very
 * decay it exists to detect. A young cell simply has no baseline, and the floor
 * holds rather than failing.
 */
function engagementGateFor(input: {
	readonly cell: DeliverabilityCell;
	readonly own: TransportOutcomeSummary;
	readonly reference: TransportOutcomeSummary | null;
	readonly ownBuckets: readonly TransportOutcomeBucket[];
	readonly window: DashboardWindow;
	readonly now: number;
}): RampGateResult {
	return evaluateEngagementGate({
		cell: input.cell,
		own: input.own,
		reference: input.reference,
		ownRecent: input.own,
		ownPriorBaseline: summarizeTransportOutcomeBuckets(input.ownBuckets, {
			since: input.window.baselineSinceDay,
			until: input.window.baselineUntilDay,
		}),
		now: input.now,
	});
}

export interface DeliverabilityDashboard {
	readonly generatedAt: number;
	readonly windowStart: number;
	readonly windowEnd: number;
	/**
	 * The second arm's transport id, or `null` for a standalone deployment. The
	 * screen switches headline and copy on this (plan D14) — it is never an
	 * error state.
	 */
	readonly referenceTransportId: string | null;
	/** Seed placement lands in a later piece; today no cell has seed coverage. */
	readonly hasSeedCoverage: boolean;
	readonly cells: readonly DashboardCellView[];
}

/**
 * The whole screen in one org-scoped read.
 *
 * ORGANIZATION SCOPE COMES FROM THE SESSION, never from an argument: there is
 * no `organizationId` arg to forge, and every index read below is org-leading.
 */
// all-members: aggregate own-vs-reference sending outcomes and gate verdicts for
// the caller's own organization — no credentials, no recipient identities, and
// no cross-tenant reach (org id comes from the session, not from args).
export const getDeliverabilityDashboard = authedQuery({
	// No arguments AT ALL, on purpose. The evaluation window is pinned to the
	// ramp's 7-day cadence by `dashboardWindow` so that the gate verdicts on this
	// screen are the verdicts the controller would reach; a caller-chosen window
	// would silently change what the gates mean.
	args: {},
	handler: async (ctx): Promise<DeliverabilityDashboard> => {
		const organizationId = await getSingletonOrganizationId(ctx);
		// The clock is read HERE, in the shell, and passed down: every decision
		// function below it is pure (plan D15). There is deliberately no `now`
		// argument — a caller-supplied clock on a public read is a way to make a
		// stale window look fresh.
		const now = Date.now();
		const window = dashboardWindow(now);
		const referenceTransportId = await referenceRelayTransportId(ctx);
		const hasReferenceArm = referenceTransportId !== null;
		const routeStates = await readRouteStatesByProvider(ctx, organizationId);
		// THE EVALUATOR IS CHOSEN BY THE DEPLOYMENT, not by the window or the cell.
		// Running the two-armed evaluator against `reference === null` grades a
		// column of holds as high-confidence direct measurement; the
		// trailing-baseline implementation is what a standalone cell is actually
		// measured by, so it is what the screen reports (plan D3, D14).
		const evaluator = hasReferenceArm ? referenceArmGateEvaluator : trailingBaselineGateEvaluator;
		// ONE read for the whole screen: seed COVERAGE is an org-level fact (are
		// there seed mailboxes at all), not a per-cell one, and it only lowers
		// confidence — a deployment with none is supported, never nagged (plan D2).
		// The per-cell PLACEMENT sweep is a separate wiring job (the roll-up is per
		// destination provider, the gate input is per cell); until it lands, gate 5
		// holds and that hold costs the ramp nothing, because it is optional.
		// ONE row through the seed index, not a placement window: the screen needs
		// the boolean, and the roll-up it used to buy it from scans the probe
		// index, expands one observation per probe and fans out a `db.get` per
		// account — all of it discarded.
		const hasSeedCoverage = await hasSeedAccounts(ctx.db, organizationId);
		const evaluationWindow = { since: window.sinceDay, until: window.untilDay };

		const cells: DashboardCellView[] = [];
		for (const cell of allDeliverabilityCells()) {
			const cellKey = deliverabilityCellKey(cell);
			const readWindow = { since: window.readSinceDay, until: window.untilDay };
			// Bounded: ≤30 days × shard count per arm, and the aging cron caps the
			// table at 90 days regardless.
			const ownBuckets = await readCellArmBuckets(ctx.db, {
				organizationId,
				cell: cellKey,
				arm: 'own',
				...readWindow,
			});
			const referenceBuckets = hasReferenceArm
				? await readCellArmBuckets(ctx.db, {
						organizationId,
						cell: cellKey,
						arm: 'reference',
						...readWindow,
					})
				: null;

			const own = summarizeTransportOutcomeBuckets(ownBuckets, evaluationWindow);
			const reference =
				referenceBuckets === null
					? null
					: summarizeTransportOutcomeBuckets(referenceBuckets, evaluationWindow);
			const routeState = pickRouteState(routeStates.get(cell.destinationProvider) ?? [], cell);

			const evaluation = evaluator.evaluate({
				config: RAMP_STREAM_CONFIGS[cell.stream],
				own,
				reference,
				ownSeeds: null,
				referenceSeeds: null,
				engagement: engagementGateFor({ cell, own, reference, ownBuckets, window, now }),
				previousCleanStreak: routeState?.cleanStreak ?? 0,
				now,
			});

			cells.push(
				buildDashboardCellView({
					cell,
					cellKey,
					ownShare: resolveOwnShare(routeState),
					phaseCeiling: routeState?.phaseCeiling ?? null,
					own,
					reference,
					evaluation,
					hasSeedCoverage,
					hasReferenceArm,
					trend: buildDashboardTrend({
						ownBuckets,
						referenceBuckets,
						sinceDay: window.sinceDay,
						untilDay: window.untilDay,
					}),
				})
			);
		}

		return {
			generatedAt: now,
			windowStart: window.sinceDay,
			windowEnd: window.untilDay,
			referenceTransportId,
			hasSeedCoverage,
			cells,
		};
	},
});
