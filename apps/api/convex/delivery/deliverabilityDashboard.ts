/**
 * Deliverability dashboard — the READ side.
 *
 * SHIP THE MEASUREMENT BEFORE THE CONTROL. This query is the human's
 * sanity-check on the gates: per cell, both arms' outcomes, every gate's
 * verdict WITH the numbers that produced it, and how much the measurement is
 * worth. It is READ-ONLY by construction — there is no mutation in this module
 * and there will not be one; the control surface lives separately.
 *
 * SHAPE. One index read per (cell, arm) over the widest window any sub-view needs
 * (the deciding span, the reported window, the trailing baseline, the daily
 * trend), every number derived from those rows by the ONE summarizer.
 *
 * WHAT THE SCREEN AND THE CONTROLLER AGREE ON, PRECISELY: THE VERDICT. One rule
 * over one span. The rule is shared — which evaluator grades the cell, which
 * constants it grades on and which complaint line applies are read off one
 * `resolveRampDegradation` fold on both sides — and BOTH ARMS reach that
 * evaluator summarized over the CONTROLLER'S evaluation window
 * (`RAMP_AIMD.evaluationWindowMs`, the cadence its cron ticks at), anchored on
 * the same clock. A hard-bounce spike four days old is outside that span on both
 * sides, so the screen does not render a red gate-1 fail on a cell the ramp is
 * holding for want of data.
 *
 * THE SEVEN DAYS ARE REPORTED, NOT DECIDING. `DASHBOARD_WINDOW_DAYS`
 * is what the arm table, the trend, the sample counts and the confidence
 * cap are reported over; the harm to avoid is a VERDICT that
 * disagrees, not a column that is wide. So each arm is summarized TWICE out of
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
 * A CELL WITH NO REFERENCE ARM IS A SUPPORTED CONFIGURATION, not an
 * incomplete setup. `reference` is `null`, the TRAILING-BASELINE evaluator runs
 * instead of the two-armed one — the standalone implementation is the honest
 * answer for a standalone cell, not a fallback — and `dashboardConfidence` caps
 * the level at what the missing measurement inputs allow, so the screen says
 * "measurement confidence: low" and names what would improve it
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

import { allDeliverabilityCells, deliverabilityCellKey } from '@owlat/shared/deliverabilityRouting';
import { authedQuery } from '../lib/authedFunctions';
import { getSingletonOrganizationId } from '../lib/sessionOrganization';
import { readCellArmBuckets } from '../analytics/transportOutcomes';
import { hasSeedAccounts } from '../analytics/seedAccounts';
import { summarizeSeedPlacementSweeps } from '../analytics/seedPlacement';
import { readCellArmCategoryBuckets } from '../analytics/smtpResponseCategories';
import { relayConfiguration } from './relayConfiguration';
import { loadRampDeploymentPresence } from './rampIntegrationPresence';
import { readRouteStatesByProvider } from './deliverabilityDashboardHelpers';
import type { DashboardCellView } from './deliverabilityDashboardView';
import {
	assembleDashboardCell,
	dashboardSpans,
	type DashboardGridFacts,
} from './deliverabilityDashboardCell';

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
	// and a caller-chosen deciding span what its verdicts mean.
	args: {},
	handler: async (ctx): Promise<DeliverabilityDashboard> => {
		const organizationId = await getSingletonOrganizationId(ctx);
		// The clock is read HERE, in the shell, and passed down: every decision
		// function below it is pure. There is deliberately no `now` arg —
		// a caller-supplied clock on a public read makes a stale window look fresh.
		const now = Date.now();
		// The reported window, the deciding span and the read bound, all from this
		// one clock reading (`./deliverabilityDashboardCell`).
		const spans = dashboardSpans(now);
		// BOTH READINGS OF THE RELAY LIST, from ONE scan (`relayConfiguration`), and
		// neither of them is the evaluator predicate — see the module note.
		//   - `referenceTransportId` NAMES the second arm for the screen's copy, and
		//     is null on a two-relay deployment because there is no one arm to name;
		//   - `isRelayConfigured` answers "does this deployment own a relay AT ALL",
		//     which is the question the `connect_reference_transport` offer asks.
		const { referenceTransportId, isRelayConfigured } = await relayConfiguration(ctx);
		const grid: DashboardGridFacts = {
			now,
			spans,
			isRelayConfigured,
			routeStates: await readRouteStatesByProvider(ctx, organizationId),
			// THE DEPLOYMENT HALF OF THE SUBSTITUTION MAP, read ONCE for the whole grid
			// through the reader the controller's tick uses. Every entry but the
			// reference arm is deployment-level; that one is completed per cell, from
			// its rows.
			deploymentPresence: await loadRampDeploymentPresence(ctx, { organizationId, now }),
			// ONE read for the whole screen: seed COVERAGE is an org-level fact (are
			// there seed mailboxes at all), not a per-cell one, and it only lowers
			// confidence — a deployment with none is supported, never nagged.
			// ONE row through the seed index, not a placement window: the screen needs
			// the boolean, and the roll-up it used to buy it from scans the probe index,
			// expands one observation per probe and fans out a `db.get` per account.
			hasSeedCoverage: await hasSeedAccounts(ctx.db, organizationId),
			// GATE 5'S EVIDENCE, from the SAME reader the controller uses and read ONCE
			// for the whole grid rather than once per cell — the probe ledger read is
			// org-wide and every cell takes its own slice out of the index. A
			// deployment with no probes gets an empty index and every cell's gate 5
			// holds, which is what it should say: the screen reports the verdict the
			// controller would reach, not a friendlier one.
			seedSweeps: await summarizeSeedPlacementSweeps(ctx.db, organizationId, now),
		};

		const cells: DashboardCellView[] = [];
		for (const cell of allDeliverabilityCells()) {
			const cellKey = deliverabilityCellKey(cell);
			const armRows = { organizationId, cell: cellKey, ...spans.readWindow };
			cells.push(
				assembleDashboardCell(grid, {
					cell,
					cellKey,
					// Bounded: ≤30 days × shard count per arm, and the aging cron caps the
					// table at 90 days regardless.
					ownBuckets: await readCellArmBuckets(ctx.db, { ...armRows, arm: 'own' }),
					// READ UNCONDITIONALLY, because whether this cell HAS a second arm is a
					// question about these very rows: skipping the read when no single relay
					// kind is configured is what made a two-relay deployment look standalone
					// to the screen and two-armed to the controller. An arm nothing sends
					// through costs one empty index read per cell and answers honestly.
					referenceBuckets: await readCellArmBuckets(ctx.db, { ...armRows, arm: 'reference' }),
					// Over the DECIDING span only: these responses exist to be graded.
					ownCategoryBuckets: await readCellArmCategoryBuckets(ctx.db, {
						organizationId,
						cell: cellKey,
						arm: 'own',
						...spans.decisionWindow,
					}),
				})
			);
		}

		return {
			generatedAt: now,
			windowStart: spans.window.sinceDay,
			windowEnd: spans.window.untilDay,
			// THE SPAN THE VERDICTS WERE REACHED OVER, on the wire beside the reported
			// one so the screen can name both. Open-ended in the summary, so its
			// end is the read's own clock — the `now` every gate was evaluated at.
			decisionWindowStart: spans.decisionWindow.since,
			decisionWindowEnd: now,
			referenceTransportId,
			isRelayConfigured,
			hasSeedCoverage: grid.hasSeedCoverage,
			cells,
		};
	},
});
