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
 *
 * WHAT THE SCREEN AND THE CONTROLLER AGREE ON, PRECISELY. One RULE over two
 * SPANS. The rule is shared and cannot differ: which evaluator grades the cell,
 * which constants it grades on and which complaint line applies are read off one
 * `resolveRampDegradation` fold on both sides. The spans are not: this screen's
 * evaluation window is SEVEN days (`DASHBOARD_WINDOW_DAYS`, floored to UTC days)
 * and the controller's is ONE (`RAMP_AIMD.evaluationWindowMs`, the cadence its
 * cron ticks at), and the trailing baseline is `30d..7d` on both sides but
 * floored to UTC days here and anchored on the tick's clock there.
 *
 * WHICH LEAVES THE VERDICT AND THE DECIDING GATE ABLE TO DIFFER, and this
 * module does not promise otherwise. A hard-bounce spike four days old is inside
 * this screen's window and outside the controller's, so the screen renders a red
 * gate-1 fail on a cell the ramp is holding for want of data. The screen is the
 * WIDER reader and therefore the more pessimistic one on a stale spike — and the
 * more forgiving one on a fresh spike that six clean days dilute. Tracked as
 * #510: closing it is a decision about which span this screen REPORTS, not a
 * wiring fix.
 *
 * AND "THE SAME CONSTANTS" IS NOT "THE SAME INPUTS". `ownTrailingBaseline` is an
 * input, built here over `BASELINE_WIDTH_DAYS` of UTC days and there over
 * `30d..7d` of the tick's clock — the same rule, again over spans that differ by
 * up to a day at each edge.
 *
 * D2. A cell with no reference arm is a SUPPORTED CONFIGURATION, not an
 * incomplete setup. `reference` is `null`, the TRAILING-BASELINE evaluator runs
 * instead of the two-armed one — the standalone implementation is the honest
 * answer for a standalone cell, not a fallback — and `dashboardConfidence` caps
 * the level at what the missing measurement inputs allow, so the screen says
 * "measurement confidence: low" and names what would improve it (plan D14)
 * rather than grading a column of holds `high`. Nothing throws, nothing renders
 * as an error, nothing is blocked.
 *
 * AND WHICH CELLS THOSE ARE IS A MEASUREMENT, NOT A CONFIGURATION. The screen
 * used to pick its evaluator from `referenceRelayTransportId` — "does this
 * deployment have exactly one relay kind configured" — while the controller
 * picked its own from whether the cell's reference arm actually SENT. The two
 * disagree on a two-relay deployment and on a relay disabled mid-window, and
 * there they graded one cell with two different evaluators and reported opposite
 * verdicts on it. So this module resolves the cell's degradation the way
 * `loadCellInput` does — the same `hasReferenceArmOutcomes` predicate, the same
 * `resolveRampDegradation` fold — and the choices that fall out of it (which
 * evaluator runs, which constants it runs on, which complaint line applies) are
 * the fold's answers here as they are there. `referenceTransportId` stays
 * configuration, because NAMING the second arm is the only question it answers.
 *
 * ONE RULE IS NOT ENOUGH — IT HAS TO BE ASKED OVER THE SAME SPAN. The predicate
 * is asked here over `RAMP_REFERENCE_ARM_WINDOW_MS`, the controller's span, and
 * NOT over this screen's seven-day window. Asked over seven days it would answer
 * "this cell has a relay" for six days after the relay went quiet, while the
 * cron had already moved the cell onto the trailing-baseline twin — the same
 * divergence one window over rather than closed. So the reference arm is
 * summarized TWICE out of the one index read: once over the controller's span,
 * which decides the evaluator, and once over the evaluation window, which is the
 * column the screen renders beside the own arm.
 *
 * WHICH IS WHY `reference` IS NULL ON A CELL WHOSE RELAY WENT QUIET four days
 * ago even though the window can still see the traffic: the arm is what the
 * evaluator was given, and it was given none. The days the relay did carry are
 * not lost — the TREND keeps plotting them, because a chart's predicate belongs
 * to the chart's own rows (see the `buildDashboardTrend` call below).
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
import { summarizeSeedPlacementSweeps } from '../analytics/seedPlacement';
import { seedSweepsForCell } from '../analytics/seedPlacementSweeps';
import {
	deferralTelemetryReadSince,
	hasUsableDeferralTelemetry,
	summarizeTransportOutcomeBuckets,
	type TransportOutcomeBucket,
	type TransportOutcomeSummary,
} from '../analytics/transportOutcomeSummary';
import { referenceRelayTransportId } from './relayConfiguration';
import { RAMP_STREAM_CONFIGS } from './ramp/gateConfig';
import { referenceArmGateEvaluator, trailingBaselineGateEvaluator } from './ramp/gateEvaluation';
import {
	degradedStreamConfig,
	resolveRampDegradation,
	usesTrailingBaseline,
	usesUnsubscribeProxy,
} from './ramp/degradation';
import {
	hasReferenceArmOutcomes,
	loadRampDeploymentPresence,
	withReferenceArm,
	RAMP_REFERENCE_ARM_WINDOW_MS,
} from './rampIntegrationPresence';
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
 * THE CELL'S TRAILING SECOND SERIES — the 30-day window that ENDS where the
 * evaluation window begins, which `dashboardWindow` makes true by construction.
 * A series that overlapped the recent window would be dragged down by the very
 * decay it exists to detect.
 *
 * ONE SUMMARY, TWO CONSUMERS, exactly as in the controller: gate 4's slow-poison
 * floor contracts for it, and the trailing-baseline evaluator's relative clauses
 * (gate 1's 1.5x rule, gate 3's unsubscribe proxy) compare against it. A young
 * cell simply has no baseline, and both hold rather than failing.
 */
function trailingBaselineFor(
	ownBuckets: readonly TransportOutcomeBucket[],
	window: DashboardWindow
): TransportOutcomeSummary {
	return summarizeTransportOutcomeBuckets(ownBuckets, {
		since: window.baselineSinceDay,
		until: window.baselineUntilDay,
	});
}

/** Gate 4 (engagement) for one cell, over the same rows every other view uses. */
function engagementGateFor(input: {
	readonly cell: DeliverabilityCell;
	readonly own: TransportOutcomeSummary;
	readonly reference: TransportOutcomeSummary | null;
	readonly ownPriorBaseline: TransportOutcomeSummary;
	readonly now: number;
}): RampGateResult {
	return evaluateEngagementGate({
		cell: input.cell,
		own: input.own,
		reference: input.reference,
		ownRecent: input.own,
		ownPriorBaseline: input.ownPriorBaseline,
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
	/**
	 * Whether ANY seed mailbox is connected — an org-level fact the screen uses to
	 * explain a held gate 5. The per-cell placement VERDICT is on the cell's own
	 * gate list; this is only the honesty denominator beside it.
	 */
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
	// No arguments AT ALL, on purpose. `dashboardWindow` fixes the evaluation
	// window at `DASHBOARD_WINDOW_DAYS`, which is NOT the controller's cadence —
	// that is one day, and the two readers can reach different verdicts because of
	// it (see the module note and #510). A caller-chosen window on top of that
	// would silently change what every gate verdict on this screen means.
	args: {},
	handler: async (ctx): Promise<DeliverabilityDashboard> => {
		const organizationId = await getSingletonOrganizationId(ctx);
		// The clock is read HERE, in the shell, and passed down: every decision
		// function below it is pure (plan D15). There is deliberately no `now`
		// argument — a caller-supplied clock on a public read is a way to make a
		// stale window look fresh.
		const now = Date.now();
		const window = dashboardWindow(now);
		// CONFIGURATION, and used for exactly one thing: NAMING the second arm in
		// the screen's copy. It is deliberately not the evaluator predicate — see
		// the module note.
		const referenceTransportId = await referenceRelayTransportId(ctx);
		const routeStates = await readRouteStatesByProvider(ctx, organizationId);
		// THE DEPLOYMENT HALF OF THE SUBSTITUTION MAP, read ONCE for the whole grid
		// through the reader the controller's tick uses. Every entry but the
		// reference arm is deployment-level; the reference arm is completed per cell
		// below, from that cell's own rows.
		const deploymentPresence = await loadRampDeploymentPresence(ctx, { organizationId, now });
		// ONE read for the whole screen: seed COVERAGE is an org-level fact (are
		// there seed mailboxes at all), not a per-cell one, and it only lowers
		// confidence — a deployment with none is supported, never nagged (plan D2).
		// ONE row through the seed index, not a placement window: the screen needs
		// the boolean, and the roll-up it used to buy it from scans the probe
		// index, expands one observation per probe and fans out a `db.get` per
		// account — all of it discarded.
		const hasSeedCoverage = await hasSeedAccounts(ctx.db, organizationId);
		// GATE 5'S EVIDENCE, from the SAME reader the controller uses and read ONCE
		// for the whole grid rather than once per cell — the probe ledger read is
		// org-wide and every cell takes its own slice out of the index. A deployment
		// with no probes gets an empty index and every cell's gate 5 holds, which is
		// what it should say: the screen must report the verdict the controller
		// would reach, not a friendlier one (ADR-0042).
		const seedSweeps = await summarizeSeedPlacementSweeps(ctx.db, organizationId, now);
		const evaluationWindow = { since: window.sinceDay, until: window.untilDay };
		// THE CONTROLLER'S SPAN, anchored on the same clock it anchors on, so the
		// evaluator predicate below covers the days the cron's covers and no others.
		// Cell-independent, so it is derived once rather than per cell.
		const referenceArmWindow = { since: now - RAMP_REFERENCE_ARM_WINDOW_MS };
		// THE SAME LOWER BOUND THE CONTROLLER READS FROM, through the same helper:
		// the screen's own 30-day baseline bound is derived from tomorrow's UTC
		// boundary and the controller's from `now`, and gate 2's instrument check
		// must not be asked of a row set one of them cannot see. Cell-independent,
		// so it is derived once rather than per cell.
		const readWindow = {
			since: Math.min(window.readSinceDay, deferralTelemetryReadSince(now)),
			until: window.untilDay,
		};

		const cells: DashboardCellView[] = [];
		for (const cell of allDeliverabilityCells()) {
			const cellKey = deliverabilityCellKey(cell);
			// Bounded: ≤30 days × shard count per arm, and the aging cron caps the
			// table at 90 days regardless.
			const ownBuckets = await readCellArmBuckets(ctx.db, {
				organizationId,
				cell: cellKey,
				arm: 'own',
				...readWindow,
			});
			// READ UNCONDITIONALLY, because whether this cell HAS a second arm is a
			// question about these very rows: skipping the read when no single relay
			// kind is configured is what made a two-relay deployment look standalone
			// to the screen and two-armed to the controller. An arm nothing sends
			// through costs one empty index read per cell and answers honestly.
			const referenceBuckets = await readCellArmBuckets(ctx.db, {
				organizationId,
				cell: cellKey,
				arm: 'reference',
				...readWindow,
			});

			const own = summarizeTransportOutcomeBuckets(ownBuckets, evaluationWindow);
			const ownTrailingBaseline = trailingBaselineFor(ownBuckets, window);
			// THE ONE PREDICATE (`hasReferenceArmOutcomes`) OVER THE CONTROLLER'S SPAN
			// — the arm is ABSENT, not empty, when nothing was sent through it, and
			// "when" has to mean the same days on both sides. Asked over this screen's
			// seven days instead, a relay switched off yesterday would keep the
			// two-armed evaluator on screen for six more days while the cron had
			// already moved the cell onto the trailing twin. Second summary, same
			// index read.
			const hasReferenceArm = hasReferenceArmOutcomes(
				summarizeTransportOutcomeBuckets(referenceBuckets, referenceArmWindow)
			);
			// THE COLUMN, over the window this screen reports: the arm the evaluator
			// was given, summarized across the same seven days as `own` beside it.
			const windowReference = summarizeTransportOutcomeBuckets(referenceBuckets, evaluationWindow);
			const reference = hasReferenceArm ? windowReference : null;
			const routeState = pickRouteState(routeStates.get(cell.destinationProvider) ?? [], cell);
			const cellSeeds = seedSweepsForCell(seedSweeps, cell);
			// THE SUBSTITUTION FOLD DECIDES, exactly as it does in `loadCellInput`:
			// which evaluator runs and which complaint line applies are read off ONE
			// resolution of this cell's presence map, never off an `if` here.
			const degradation = resolveRampDegradation({
				presence: withReferenceArm(deploymentPresence, hasReferenceArm),
				provider: cell.destinationProvider,
			});
			const evaluator = usesTrailingBaseline(degradation)
				? trailingBaselineGateEvaluator
				: referenceArmGateEvaluator;

			const evaluation = evaluator.evaluate({
				// THE TABLE'S CONSTANTS, not the shipped ones. The tightening the fold
				// applies is not advisory — a deployment with no feedback loop is
				// judged against a complaint ceiling half as wide, and the controller
				// acts on that number. A screen showing the equipped ceiling passes
				// cells the cron is failing (`complaintMax` 0.1% against 0.05%).
				//
				// The operator's PRESET is deliberately not read here: it tunes
				// `increaseStep` and `cleanWindowsRequired`, and neither reaches a gate
				// verdict — they size the controller's MOVE, which this screen reports
				// from the route state rather than re-deriving.
				config: degradedStreamConfig(RAMP_STREAM_CONFIGS[cell.stream], degradation),
				own,
				reference,
				// The trailing twin's second series, DISJOINT from the evaluation
				// window by construction. The reference-arm evaluator has a concurrent
				// arm and ignores it.
				ownTrailingBaseline,
				// THROUGH THE FOLD, never off the presence map — `usesUnsubscribeProxy`
				// is the table's answer to "is there a real feedback loop on this
				// cell?", and the controller asks the same resolution.
				hasComplaintFeedback: !usesUnsubscribeProxy(degradation),
				// This cell's slice of the one ledger read; absent on both arms for a
				// cell the poller has classified nothing for, which HOLDS gate 5.
				ownSeeds: cellSeeds.own,
				referenceSeeds: cellSeeds.reference,
				// THE SAME OBSERVATION THE CONTROLLER MAKES, over the same span of the
				// same rows (`hasUsableDeferralTelemetry`). Gate 2 holds on a cell whose
				// `deferred` counter has no writer instead of reporting a 0% pass, and a
				// screen that skipped this would render "Healthy" beside a verdict the
				// controller reached as "Not enough data yet". The predicate anchors its
				// span on the CLOCK and clamps its rows to it, so the two cannot differ
				// even where their read bounds do.
				hasDeferralTelemetry: hasUsableDeferralTelemetry(ownBuckets, now),
				engagement: engagementGateFor({
					cell,
					own,
					reference,
					ownPriorBaseline: ownTrailingBaseline,
					now,
				}),
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
					// THE MEASURED ARM, not the configured one. `dashboardConfidence`
					// caps the level at `high` only where a concurrent arm actually
					// produced the comparison the level claims, and it offers
					// `connect_reference_transport` exactly where none did — both are
					// statements about this cell's window, and pinning them to the
					// deployment's relay list graded a cell by a relay that never
					// carried it.
					hasReferenceArm,
					trend: buildDashboardTrend({
						ownBuckets,
						// THE SAME PREDICATE, OVER THE CHART'S OWN ROWS. A chart is a
						// question about the days it plots, so the series exists when the
						// relay carried something inside the plotted window — not when it
						// carried something in the last 24 hours. Scoping this to the
						// evaluator's span would erase the very days that explain why the
						// arm is gone; scoping it to nothing at all would draw a flat line
						// of zeros that reads as a relay sending nothing.
						referenceBuckets: hasReferenceArmOutcomes(windowReference) ? referenceBuckets : null,
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
