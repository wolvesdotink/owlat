/**
 * Deliverability dashboard — the READ side (plan D2, D5, D14, D15).
 *
 * SHIP THE MEASUREMENT BEFORE THE CONTROL. This query is the human's
 * sanity-check on the gates: per cell, both arms' outcomes, every gate's
 * verdict WITH the numbers that produced it, and how much the measurement is
 * worth. It is READ-ONLY by construction — there is no mutation in this module
 * and there will not be one; P3-6 adds the control surface separately.
 *
 * SHAPE. One index read per (cell, arm) over the widest window any sub-view needs
 * (the deciding span, the reported window, the trailing baseline, the daily
 * trend), every number derived from those rows by the ONE summarizer (ADR-0042).
 *
 * WHAT THE SCREEN AND THE CONTROLLER AGREE ON, PRECISELY: THE VERDICT. One rule
 * over one span. The rule is shared — which evaluator grades the cell, which
 * constants it grades on and which complaint line applies are read off one
 * `resolveRampDegradation` fold on both sides — and BOTH ARMS now reach that
 * evaluator summarized over the CONTROLLER'S evaluation window
 * (`RAMP_AIMD.evaluationWindowMs`, the cadence its cron ticks at), anchored on
 * the same clock. A hard-bounce spike four days old is outside that span on both
 * sides, so the screen no longer renders a red gate-1 fail on a cell the ramp is
 * holding for want of data (#510).
 *
 * THE SEVEN DAYS DID NOT GO AWAY — THEY STOPPED DECIDING. `DASHBOARD_WINDOW_DAYS`
 * is still what the arm table, the trend, the sample counts and the confidence
 * cap are reported over (plan D2/D5); the harm in #510 was a VERDICT that
 * disagreed, not a column that was wide. So each arm is summarized TWICE out of
 * the one index read it already costs — the deciding span for the evaluator, the
 * reported window for the cards — and BOTH ARE NAMED ON THE WIRE
 * (`windowStart`/`windowEnd` beside `decisionWindowStart`/`decisionWindowEnd`),
 * so the screen labels every number with the span it is over.
 *
 * WHAT STILL DIFFERS, AND IT IS NOT WHAT THE WINDOW'S OWN GATES DECIDE ON.
 * `ownTrailingBaseline` is built here over `BASELINE_WIDTH_DAYS` of UTC days and
 * there over `30d..7d` of the tick's clock, and the engagement floor's RECENT arm
 * is this screen's seven UTC days against the controller's `[now - 7d, now)`.
 * Same rule, spans that differ by up to a day at each edge: enough to move the
 * clauses that compare a cell against its OWN past where the baseline is thin at
 * exactly that edge, and never enough to grade the two arms on different rows.
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
 * evaluator runs, which constants, which complaint line) are the fold's answers
 * here as they are there. `referenceTransportId` stays configuration, because
 * NAMING the second arm is all it answers, and `isRelayConfigured` travels beside
 * it for the one other configuration question the screen asks: whether "connect a
 * relay you already pay for" is advice this deployment can act on.
 *
 * ONE RULE IS NOT ENOUGH — IT HAS TO BE ASKED OVER THE SAME SPAN. The predicate
 * is asked here OF THE SAME SUMMARY the evaluator is given, exactly as
 * `loadCellInput` asks it, so "does this cell have a relay?" and "what did that
 * relay do?" can never answer over different days. Asked over seven days it
 * would keep the two-armed evaluator on screen for six days after the relay went
 * quiet, while the cron had already moved the cell onto the trailing twin.
 *
 * WHICH IS WHY `reference` IS NULL ON A CELL WHOSE RELAY WENT QUIET four days
 * ago even though the reported window can still see the traffic: the arm is what
 * the evaluator was given, and it was given none. The days the relay did carry
 * are not lost — the TREND keeps plotting them, because a chart's predicate
 * belongs to the chart's own rows (see the `buildDashboardTrend` call below).
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
import { relayConfiguration } from './relayConfiguration';
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
	loadRampDeploymentPresence,
	withReferenceArm,
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
 *
 * ON UTC DAYS, WHERE THE CONTROLLER'S IS ON THE TICK'S CLOCK — the one span the
 * two readers still floor differently (see the module note). It stays that way
 * because the baseline's DISJOINTNESS from the reported window is what
 * `dashboardWindow` makes true by construction.
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

/**
 * Gate 4 (engagement) for one cell, over the same rows every other view uses.
 *
 * BOTH SPANS ARE ARGUMENTS, because this gate reads both: the concurrent RATIO
 * compares the arms over the deciding window, the slow-poison FLOOR compares a
 * RECENT window against the prior baseline. One summary for both — which this
 * screen passed while it graded everything over seven days — hands the ratio a
 * week where the cron gives it a day.
 */
function engagementGateFor(input: {
	readonly cell: DeliverabilityCell;
	readonly own: TransportOutcomeSummary;
	readonly reference: TransportOutcomeSummary | null;
	readonly ownRecent: TransportOutcomeSummary;
	readonly ownPriorBaseline: TransportOutcomeSummary;
	readonly now: number;
}): RampGateResult {
	return evaluateEngagementGate({
		cell: input.cell,
		own: input.own,
		reference: input.reference,
		ownRecent: input.ownRecent,
		ownPriorBaseline: input.ownPriorBaseline,
		now: input.now,
	});
}

export interface DeliverabilityDashboard {
	readonly generatedAt: number;
	/**
	 * THE REPORTED WINDOW — inclusive start, exclusive end, `DASHBOARD_WINDOW_DAYS`
	 * of UTC days. Every COUNTER and RATE on a cell (`own`, `reference`, the trend,
	 * the confidence cap) is summarized over exactly this span, and no verdict is.
	 */
	readonly windowStart: number;
	readonly windowEnd: number;
	/**
	 * THE DECIDING SPAN — the controller's own evaluation window, and what every
	 * `verdict`, `failedGate` and per-gate `measurement` below was reached over.
	 * Outcomes are stored in DAILY buckets, so the rows behind those verdicts are
	 * the UTC days this span touches, exactly as they are in the cron. Reported so
	 * the screen can name it beside the window heading; nothing decides on it here.
	 */
	readonly decisionWindowStart: number;
	readonly decisionWindowEnd: number;
	/**
	 * WHAT TO CALL THE SECOND ARM, and nothing else. It is the id of the single
	 * configured relay kind, and `null` for TWO configurations that have nothing
	 * else in common: a standalone deployment with no relay at all, and a
	 * deployment relaying through more than one kind, which has a second arm and
	 * no single one to name.
	 *
	 * THE SCREEN'S FRAMING DOES NOT COME FROM THIS FIELD. Headline, subhead and
	 * the standalone note are keyed to whether the CELLS below measured a second
	 * arm; this only fills in its name once they have. Read as the framing, it
	 * told a two-relay deployment it sends entirely from its own server directly
	 * above cards carrying a relay column.
	 */
	readonly referenceTransportId: string | null;
	/**
	 * Does this deployment own a relay AT ALL — the other reading of the same
	 * list, true wherever any relay kind is configured.
	 *
	 * IT ANSWERS ONE QUESTION: whether to offer "connect a relay you already pay
	 * for". That offer is advice about the CONFIGURATION and nobody with a relay
	 * connected can act on it, so a screen that keyed it to the measurement made
	 * the offer to a deployment whose own cards were explaining that its relay
	 * went quiet. `dashboardConfidence` splits the per-cell offer from the
	 * per-cell cap on exactly this line.
	 */
	readonly isRelayConfigured: boolean;
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
	// No arguments AT ALL, on purpose: the REPORTED window is fixed at
	// `DASHBOARD_WINDOW_DAYS` and the DECIDING span at the controller's cadence.
	// A caller-chosen window would silently change what every number here is over,
	// and a caller-chosen deciding span what its verdicts mean (#510).
	args: {},
	handler: async (ctx): Promise<DeliverabilityDashboard> => {
		const organizationId = await getSingletonOrganizationId(ctx);
		// The clock is read HERE, in the shell, and passed down: every decision
		// function below it is pure (plan D15). There is deliberately no `now` arg —
		// a caller-supplied clock on a public read makes a stale window look fresh.
		const now = Date.now();
		const window = dashboardWindow(now);
		// BOTH READINGS OF THE RELAY LIST, from ONE scan (`relayConfiguration`), and
		// neither of them is the evaluator predicate — see the module note.
		//   - `referenceTransportId` NAMES the second arm for the screen's copy, and
		//     is null on a two-relay deployment because there is no one arm to name;
		//   - `isRelayConfigured` answers "does this deployment own a relay AT ALL",
		//     which is the question the `connect_reference_transport` offer asks.
		const { referenceTransportId, isRelayConfigured } = await relayConfiguration(ctx);
		const routeStates = await readRouteStatesByProvider(ctx, organizationId);
		// THE DEPLOYMENT HALF OF THE SUBSTITUTION MAP, read ONCE for the whole grid
		// through the reader the controller's tick uses. Every entry but the reference
		// arm is deployment-level; that one is completed per cell below, from its rows.
		const deploymentPresence = await loadRampDeploymentPresence(ctx, { organizationId, now });
		// ONE read for the whole screen: seed COVERAGE is an org-level fact (are
		// there seed mailboxes at all), not a per-cell one, and it only lowers
		// confidence — a deployment with none is supported, never nagged (plan D2).
		// ONE row through the seed index, not a placement window: the screen needs
		// the boolean, and the roll-up it used to buy it from scans the probe index,
		// expands one observation per probe and fans out a `db.get` per account.
		const hasSeedCoverage = await hasSeedAccounts(ctx.db, organizationId);
		// GATE 5'S EVIDENCE, from the SAME reader the controller uses and read ONCE
		// for the whole grid rather than once per cell — the probe ledger read is
		// org-wide and every cell takes its own slice out of the index. A deployment
		// with no probes gets an empty index and every cell's gate 5 holds, which is
		// what it should say: the screen reports the verdict the controller would
		// reach, not a friendlier one (ADR-0042).
		const seedSweeps = await summarizeSeedPlacementSweeps(ctx.db, organizationId, now);
		// THE REPORTED WINDOW: the seven UTC days every counter, rate and trend point
		// on this screen is summarized over (plan D2/D5). Nothing is GRADED over it.
		const reportedWindow = { since: window.sinceDay, until: window.untilDay };
		// THE DECIDING SPAN: the controller's own evaluation window, anchored on the
		// same clock its tick anchors on, so both arms reach the evaluator over the
		// days the cron's arms cover and no others (#510). It answers the reference
		// arm's PRESENCE predicate too — `RAMP_REFERENCE_ARM_WINDOW_MS` is pinned
		// equal to this constant. Cell-independent, so it is derived once.
		const decisionWindow = { since: now - RAMP_AIMD.evaluationWindowMs };
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

			// TWO SUMMARIES PER ARM, ONE INDEX READ EACH: the DECIDING pair the
			// evaluator grades and the REPORTED pair the cards render. The second
			// summary costs nothing the read has not already paid for, and it is the
			// whole of #510's fix — the screen used to hand the evaluator the reported
			// pair, and so reached verdicts the cron never reached.
			const decisionOwn = summarizeTransportOutcomeBuckets(ownBuckets, decisionWindow);
			const reportedOwn = summarizeTransportOutcomeBuckets(ownBuckets, reportedWindow);
			const ownTrailingBaseline = trailingBaselineFor(ownBuckets, window);
			// THE ONE PREDICATE (`hasReferenceArmOutcomes`) OVER THE SUMMARY IT GRADES
			// — the arm is ABSENT, not empty, when nothing was sent through it, and
			// "when" has to mean the same days on both sides. Asked over this screen's
			// seven days instead, a relay switched off yesterday would keep the
			// two-armed evaluator on screen for six more days.
			const decisionReference = summarizeTransportOutcomeBuckets(referenceBuckets, decisionWindow);
			const hasReferenceArm = hasReferenceArmOutcomes(decisionReference);
			// THE ARM THE EVALUATOR IS GIVEN, and the COLUMN the screen renders beside
			// the own arm — one arm over two spans, present or absent together, so a
			// card can never show a relay column the verdict was not graded on.
			const referenceArm = hasReferenceArm ? decisionReference : null;
			const windowReference = summarizeTransportOutcomeBuckets(referenceBuckets, reportedWindow);
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
				// THE DECIDING PAIR, never the reported one (#510).
				own: decisionOwn,
				reference: referenceArm,
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

			cells.push(
				buildDashboardCellView({
					cell,
					cellKey,
					ownShare: resolveOwnShare(routeState),
					phaseCeiling: routeState?.phaseCeiling ?? null,
					// THE REPORTED PAIR: columns, counters and the honesty denominator are
					// the seven days plan D2/D5 specifies. The VERDICT beside them travels
					// inside `evaluation`, over the deciding span.
					own: reportedOwn,
					reference,
					evaluation,
					hasSeedCoverage,
					// THE CAP TAKES THE MEASURED ARM: a cell is graded `high` only where
					// a concurrent arm actually produced the comparison the level claims,
					// and pinning that to the deployment's relay list graded a cell by a
					// relay that never carried it.
					hasReferenceArm,
					// THE OFFER TAKES THE CONFIGURED ONE, because "connect a relay you
					// already pay for" is advice about the deployment and nobody with a
					// relay connected can act on it. Off the measurement it would appear
					// and disappear day to day on a low-volume cell of a fully relayed
					// deployment, on the days that relay happened to carry nothing.
					hasRelayConfigured: isRelayConfigured,
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
			// THE SPAN THE VERDICTS WERE REACHED OVER, on the wire beside the reported
			// one so the screen can name both (#510). Open-ended in the summary, so its
			// end is the read's own clock — the `now` every gate was evaluated at.
			decisionWindowStart: decisionWindow.since,
			decisionWindowEnd: now,
			referenceTransportId,
			isRelayConfigured,
			hasSeedCoverage,
			cells,
		};
	},
});
