/**
 * Deliverability dashboard — one cell's card, assembled from the rows the
 * query loaded.
 *
 * Pure: `deliverabilityDashboard.ts:getDeliverabilityDashboard` reads the
 * clock, the grid-wide facts and each cell's index rows, and hands them here.
 * Everything this module decides (which span each number is over, which
 * evaluator grades the cell, what the card and its trend show) is the
 * controller's rule asked of those rows; see the query module's note for why
 * each choice matches `loadCellInput`.
 */

import {
	resolveOwnShare,
	type DeliverabilityCell,
	type DeliverabilityCellKey,
} from '@owlat/shared/deliverabilityRouting';
import type { Doc } from '../_generated/dataModel';
import { seedSweepsForCell, type SeedPlacementSweepIndex } from '../analytics/seedPlacementSweeps';
import {
	summarizeSmtpBlockObservation,
	type SmtpCategoryBucket,
} from '../analytics/smtpResponseCategories';
import {
	deferralTelemetryReadSince,
	hasUsableDeferralTelemetry,
	summarizeTransportOutcomeBuckets,
	type TransportOutcomeBucket,
} from '../analytics/transportOutcomeSummary';
import { RAMP_AIMD } from './ramp/controllerConfig';
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
	withReferenceArm,
	type RampDeploymentPresence,
} from './rampIntegrationPresence';
import {
	engagementGateFor,
	pickRouteState,
	trailingBaselineFor,
} from './deliverabilityDashboardHelpers';
import {
	buildDashboardCellView,
	buildDashboardTrend,
	dashboardWindow,
	type DashboardCellView,
	type DashboardWindow,
} from './deliverabilityDashboardView';

/** Every span the screen is summarized over, from one clock reading. */
export interface DashboardSpans {
	readonly window: DashboardWindow;
	/** The seven UTC days every counter, rate and trend point is over. Nothing is GRADED over it. */
	readonly reportedWindow: { readonly since: number; readonly until: number };
	/** The controller's own evaluation window: what every verdict is reached over. */
	readonly decisionWindow: { readonly since: number };
	/** The lower bound both arms' bucket reads start from. */
	readonly readWindow: { readonly since: number; readonly until: number };
}

export function dashboardSpans(now: number): DashboardSpans {
	const window = dashboardWindow(now);
	return {
		window,
		reportedWindow: { since: window.sinceDay, until: window.untilDay },
		// Anchored on the same clock the controller's tick anchors on, so both arms
		// reach the evaluator over the days the cron's arms cover and no others. It
		// answers the reference arm's PRESENCE predicate too —
		// `RAMP_REFERENCE_ARM_WINDOW_MS` is pinned equal to this constant.
		decisionWindow: { since: now - RAMP_AIMD.evaluationWindowMs },
		// THE SAME LOWER BOUND THE CONTROLLER READS FROM, through the same helper:
		// the screen's own 30-day baseline bound is derived from tomorrow's UTC
		// boundary and the controller's from `now`, and gate 2's instrument check
		// must not be asked of a row set one of them cannot see.
		readWindow: {
			since: Math.min(window.readSinceDay, deferralTelemetryReadSince(now)),
			until: window.untilDay,
		},
	};
}

/** The grid-wide facts the query reads once, before any cell. */
export interface DashboardGridFacts {
	readonly now: number;
	readonly spans: DashboardSpans;
	readonly isRelayConfigured: boolean;
	/** Every route state row of the org, by destination provider. */
	readonly routeStates: ReadonlyMap<string, readonly Doc<'deliverabilityRouteStates'>[]>;
	readonly deploymentPresence: RampDeploymentPresence;
	readonly hasSeedCoverage: boolean;
	readonly seedSweeps: SeedPlacementSweepIndex;
}

/** One cell's index rows, as the query read them. */
export interface DashboardCellRows {
	readonly cell: DeliverabilityCell;
	readonly cellKey: DeliverabilityCellKey;
	/** Both arms over `spans.readWindow`, read whether or not a relay is configured. */
	readonly ownBuckets: readonly TransportOutcomeBucket[];
	readonly referenceBuckets: readonly TransportOutcomeBucket[];
	/** The own arm's classified SMTP responses over `spans.decisionWindow`. */
	readonly ownCategoryBuckets: readonly SmtpCategoryBucket[];
}

export function assembleDashboardCell(
	grid: DashboardGridFacts,
	rows: DashboardCellRows
): DashboardCellView {
	const { now, spans } = grid;
	const { cell, ownBuckets, referenceBuckets } = rows;

	// WHAT THE RECEIVERS SAID, over the DECIDING span — the same rows and the
	// same summarizer the controller reads, because this observation exists only
	// to be GRADED: gate 2's block clause takes it, and a clause graded over the
	// reported seven days would reach verdicts the cron never reached. `null` for
	// a cell with no classified responses in the window, so the block clause holds
	// its verdict rather than rendering a measured zero.
	const smtpBlocks = summarizeSmtpBlockObservation(rows.ownCategoryBuckets, spans.decisionWindow);

	// TWO SUMMARIES PER ARM, ONE INDEX READ EACH: the DECIDING pair the evaluator
	// grades and the REPORTED pair the cards render. Handing the evaluator the
	// reported pair would reach verdicts the cron never reached.
	const decisionOwn = summarizeTransportOutcomeBuckets(ownBuckets, spans.decisionWindow);
	const reportedOwn = summarizeTransportOutcomeBuckets(ownBuckets, spans.reportedWindow);
	const ownTrailingBaseline = trailingBaselineFor(ownBuckets, spans.window);
	// THE ONE PREDICATE (`hasReferenceArmOutcomes`) OVER THE SUMMARY IT GRADES —
	// the arm is ABSENT, not empty, when nothing was sent through it, and "when"
	// has to mean the same days on both sides. Asked over this screen's seven days
	// instead, a relay switched off yesterday would keep the two-armed evaluator on
	// screen for six more days.
	const decisionReference = summarizeTransportOutcomeBuckets(
		referenceBuckets,
		spans.decisionWindow
	);
	const hasReferenceArm = hasReferenceArmOutcomes(decisionReference);
	// THE ARM THE EVALUATOR IS GIVEN, and the COLUMN the screen renders beside the
	// own arm — one arm over two spans, present or absent together, so a card can
	// never show a relay column the verdict was not graded on.
	const referenceArm = hasReferenceArm ? decisionReference : null;
	const windowReference = summarizeTransportOutcomeBuckets(referenceBuckets, spans.reportedWindow);
	const routeState = pickRouteState(grid.routeStates.get(cell.destinationProvider) ?? [], cell);
	const cellSeeds = seedSweepsForCell(grid.seedSweeps, cell);
	// THE SUBSTITUTION FOLD DECIDES, exactly as it does in `loadCellInput`: which
	// evaluator runs and which complaint line applies are read off ONE resolution
	// of this cell's presence map, never off an `if` here.
	const degradation = resolveRampDegradation({
		presence: withReferenceArm(grid.deploymentPresence, hasReferenceArm),
		provider: cell.destinationProvider,
	});
	const evaluator = usesTrailingBaseline(degradation)
		? trailingBaselineGateEvaluator
		: referenceArmGateEvaluator;

	const evaluation = evaluator.evaluate({
		// THE TABLE'S CONSTANTS, not the shipped ones. The tightening the fold
		// applies is not advisory — a deployment with no feedback loop is judged
		// against a complaint ceiling half as wide, and the controller acts on that
		// number. A screen showing the equipped ceiling passes cells the cron is
		// failing (`complaintMax` 0.1% against 0.05%).
		//
		// The operator's PRESET is deliberately not read here: it tunes
		// `increaseStep` and `cleanWindowsRequired`, and neither reaches a gate
		// verdict — they size the controller's MOVE, which this screen reports from
		// the route state rather than re-deriving.
		config: degradedStreamConfig(RAMP_STREAM_CONFIGS[cell.stream], degradation),
		// THE DECIDING PAIR, never the reported one.
		own: decisionOwn,
		reference: referenceArm,
		// The trailing twin's second series, DISJOINT from the evaluation window by
		// construction. The reference-arm evaluator has a concurrent arm and
		// ignores it.
		ownTrailingBaseline,
		// THROUGH THE FOLD, never off the presence map — `usesUnsubscribeProxy` is
		// the table's answer to "is there a real feedback loop on this cell?", and
		// the controller asks the same resolution.
		hasComplaintFeedback: !usesUnsubscribeProxy(degradation),
		// This cell's slice of the one ledger read; absent on both arms for a cell
		// the poller has classified nothing for, which HOLDS gate 5.
		ownSeeds: cellSeeds.own,
		referenceSeeds: cellSeeds.reference,
		// THE SAME OBSERVATION THE CONTROLLER MAKES, over the same span of the same
		// rows (`hasUsableDeferralTelemetry`). Gate 2 holds on a cell whose
		// `deferred` counter has no writer instead of reporting a 0% pass, and a
		// screen that skipped this would render "Healthy" beside a verdict the
		// controller reached as "Not enough data yet". The predicate anchors its
		// span on the CLOCK and clamps its rows to it, so the two cannot differ even
		// where their read bounds do.
		hasDeferralTelemetry: hasUsableDeferralTelemetry(ownBuckets, now),
		// ABSENT, NEVER ZEROED — the same distinction the controller reads, drawn in
		// the same summarizer over the same rows.
		smtpBlocks,
		engagement: engagementGateFor({
			cell,
			own: decisionOwn,
			reference: referenceArm,
			// THE FLOOR'S RECENT ARM is seven days on both sides, so the REPORTED
			// summary is the one to hand it; the deciding one would compare a day
			// against a month.
			ownRecent: reportedOwn,
			ownPriorBaseline: ownTrailingBaseline,
			now,
		}),
		previousCleanStreak: routeState?.cleanStreak ?? 0,
		now,
	});

	return buildDashboardCellView({
		cell,
		cellKey: rows.cellKey,
		ownShare: resolveOwnShare(routeState),
		phaseCeiling: routeState?.phaseCeiling ?? null,
		// THE REPORTED PAIR: columns, counters and the honesty denominator are the
		// seven reported days. The VERDICT beside them travels inside `evaluation`,
		// over the deciding span.
		own: reportedOwn,
		reference: hasReferenceArm ? windowReference : null,
		evaluation,
		hasSeedCoverage: grid.hasSeedCoverage,
		// THE CAP TAKES THE MEASURED ARM: a cell is graded `high` only where a
		// concurrent arm actually produced the comparison the level claims, and
		// pinning that to the deployment's relay list graded a cell by a relay that
		// never carried it.
		hasReferenceArm,
		// THE OFFER TAKES THE CONFIGURED ONE, because "connect a relay you already
		// pay for" is advice about the deployment and nobody with a relay connected
		// can act on it. Off the measurement it would appear and disappear day to
		// day on a low-volume cell of a fully relayed deployment, on the days that
		// relay happened to carry nothing.
		hasRelayConfigured: grid.isRelayConfigured,
		trend: buildDashboardTrend({
			ownBuckets,
			// THE SAME PREDICATE, OVER THE CHART'S OWN ROWS. A chart is a question
			// about the days it plots, so the series exists when the relay carried
			// something inside the plotted window — not when it carried something in
			// the last 24 hours. Scoping this to the evaluator's span would erase the
			// very days that explain why the arm is gone; scoping it to nothing at all
			// would draw a flat line of zeros that reads as a relay sending nothing.
			referenceBuckets: hasReferenceArmOutcomes(windowReference) ? referenceBuckets : null,
			sinceDay: spans.window.sinceDay,
			untilDay: spans.window.untilDay,
		}),
	});
}
