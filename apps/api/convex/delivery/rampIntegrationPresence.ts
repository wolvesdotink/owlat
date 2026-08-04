/**
 * WHICH INTEGRATIONS THIS DEPLOYMENT ACTUALLY HAS (plan D2, D3).
 *
 * The READ half of the degradation matrix: `delivery/ramp/degradationMatrix.ts`
 * says what an absent integration costs, and this module answers whether it is
 * absent. Nothing here decides anything — it reads rows and returns booleans, so
 * the substitution stays a property of the table.
 *
 * WHY THIS IS NOT IN `delivery/ramp/`: that directory is the PURE core, and
 * `ramp/__tests__/gates.purity.test.ts` forbids a database handle in any file it
 * finds there.
 *
 * PRESENCE IS OBSERVED, NEVER CONFIGURED. There is no "I have connected SNDS"
 * flag to tick: an integration is present when its data is present. A key that
 * stops being renewed therefore degrades exactly like one that was never added —
 * within one evaluation window and with no operator action — which is the
 * acceptance criterion this piece is measured against.
 *
 * ABSENCE IS A SUPPORTED CONFIGURATION (D2): every read below is allowed to find
 * nothing, and finding nothing is never an error.
 */

import {
	deliverabilityCellKey,
	type DeliverabilityCell,
} from '@owlat/shared/deliverabilityRouting';
import { MS_PER_DAY } from '../lib/constants';
import { summarizeTransportOutcomes } from '../analytics/transportOutcomes';
import type { TransportOutcomeSummary } from '../analytics/transportOutcomeSummary';
import { RAMP_AIMD } from './ramp/controllerConfig';
import { resolveRampDegradation, type RampDegradation } from './ramp/degradation';
import type { RampIntegrationPresence } from './ramp/degradationMatrix';
import type { RampReadCtx } from './rampReadCtx';

/**
 * How recently an integration must have produced data to count as connected.
 *
 * THREE DAYS: three cadences of a DAILY feed. Google Postmaster, SNDS, the CFL
 * enrollment feed and the seed probes all report daily, so the flap guard only
 * has to absorb an ordinary missed day or two — two spare cadences do that, and
 * a wider window buys nothing but staleness.
 *
 * THE ACCEPTANCE CRITERION IS "WITHIN ONE WINDOW" (the piece's own), and the
 * evaluation window is `RAMP_AIMD.evaluationWindowMs` — 24h. A 30-day window
 * would have kept the EQUIPPED constants (full step, K_CLEAN 3, no doubled
 * dwell, no capped ceiling) running for thirty windows after a key was revoked,
 * which is exactly the "the degraded path is never taken so it rots" failure
 * this piece exists to prevent. Three days is the smallest window that still
 * tolerates the feeds' own jitter; the boundary is fixture-pinned.
 */
export const RAMP_INTEGRATION_FRESHNESS_MS = 3 * MS_PER_DAY;

/**
 * How far back a cell's reference arm is looked for.
 *
 * THE SAME WINDOW `loadCellInput` JUDGES THE ARM OVER, deliberately: "does this
 * cell have a relay?" must be one fact, and two readers answering it over
 * different spans is how the promotion path and the controller come to disagree
 * about which actuator a cell is on.
 *
 * EVERY READER THAT PICKS AN EVALUATOR ANCHORS ON THIS CONSTANT, including the
 * ones whose own window is wider. The delivery dashboard summarizes seven days,
 * and it still chooses the cell's evaluator over THIS span — a screen that chose
 * over its own would keep the two-armed one for six days after the relay went
 * quiet while the cron had already switched, which is the same divergence one
 * window over. A reader asking about a DIFFERENT ROW SET (the same screen's
 * trend, over the days its chart plots) is not choosing an evaluator and does
 * not anchor here.
 */
export const RAMP_REFERENCE_ARM_WINDOW_MS = RAMP_AIMD.evaluationWindowMs;

/** Enrollment rows scanned when looking for a live feedback loop. */
const CFL_ENROLLMENT_SCAN_LIMIT = 20;

/**
 * The deployment-level half of the presence map. The reference transport is
 * per-CELL (a relay can carry Gmail traffic and nothing else), so it is supplied
 * by the caller that already knows the cell's reference arm.
 */
export type RampDeploymentPresence = Omit<RampIntegrationPresence, 'reference_transport'>;

export async function loadRampDeploymentPresence(
	ctx: RampReadCtx,
	args: { readonly organizationId: string; readonly now: number }
): Promise<RampDeploymentPresence> {
	const since = args.now - RAMP_INTEGRATION_FRESHNESS_MS;

	const postmasterRow = await ctx.db
		.query('googlePostmasterStats')
		.withIndex('by_period', (q) => q.gte('periodStart', since))
		.first();

	const sndsRow = await ctx.db
		.query('sndsIpDailyStats')
		.withIndex('by_period', (q) => q.gte('periodStart', since))
		.first();

	const seedRow = await ctx.db
		.query('seedPlacementProbes')
		.withIndex('by_org_and_sent_at', (q) =>
			q.eq('organizationId', args.organizationId).gte('sentAt', since)
		)
		.first();

	const enrollments = await ctx.db
		.query('yahooCflEnrollments')
		.withIndex('by_org_domain', (q) => q.eq('organizationId', args.organizationId))
		.take(CFL_ENROLLMENT_SCAN_LIMIT);

	return {
		google_postmaster: postmasterRow !== null,
		microsoft_snds: sndsRow !== null,
		seed_mailboxes: seedRow !== null,
		// WHAT IS ACTUALLY OBSERVED TODAY is a live Yahoo CFL enrollment — that is
		// the only feedback loop this deployment enrols in so far. The matrix key is
		// the general one ("any FBL enrollment") because the plan's row is, and
		// because a JMRP enrollment is meant to satisfy the same key rather than a
		// second one; when JMRP lands it is an extra clause HERE, not a new entry in
		// the table and not a second confidence note.
		complaint_feedback_loop: enrollments.some((row) => row.state === 'enrolled'),
		// NOTHING IN THIS DEPLOYMENT INTEGRATES A COMMERCIAL PLACEMENT SERVICE, and
		// the matrix says that costs nothing — self-hosted seeds are the EXPECTED
		// configuration for placement (plan D17). Hard `false` rather than a
		// speculative credential lookup for a product we do not integrate (D20).
		//
		// Its table entry therefore carries `offersImprovement: false`: permanently
		// absent AND permanently free, so it contributes neither a note nor an offer
		// and no cell renders an affordance nobody can take up.
		commercial_placement_api: false,
	};
}

/** Complete the presence map with the cell's own reference-arm observation. */
export function withReferenceArm(
	deployment: RampDeploymentPresence,
	hasReferenceArm: boolean
): RampIntegrationPresence {
	return { ...deployment, reference_transport: hasReferenceArm };
}

/**
 * THE REFERENCE-ARM PREDICATE ITSELF, over a summary the caller already holds.
 *
 * A reference arm is ABSENT, not empty, when nothing was sent through it. This
 * is a MEASUREMENT — did the second arm carry this cell in this window — and
 * never the configuration question `referenceRelayTransportId` answers, which
 * names the single relay kind a deployment has set up. The two disagree on a
 * two-relay deployment (no single arm to name, but every cell is measured
 * against one) and on a relay disabled part-way through a window (nothing to
 * name any more, but the rows are still there), and a reader that chose the
 * gate evaluator by the configuration reported the other evaluator's verdict.
 *
 * THE SPAN IS PART OF THE RULE WHEREVER THE ANSWER CHOOSES AN EVALUATOR. Every
 * caller that grades a cell by it applies it over `RAMP_REFERENCE_ARM_WINDOW_MS`
 * and none over a window of its own, however wide the rest of that caller's
 * reporting is: one rule over two spans still lets two readers put one cell on
 * two evaluators, only later. A caller asking the same question of a DIFFERENT
 * ROW SET is asking about ITS OWN rows and scopes to them — the dashboard's
 * trend plots a relay series when the relay carried something inside the days
 * the chart plots (`deliverabilityDashboard.ts`), and re-scoping that one to 24h
 * would erase the very days that explain the absent arm. `loadCellInput` states
 * the rule inline over the summary it already holds and is pinned against this
 * one by the agreement suite in `delivery/__tests__/seedGateWiring.test.ts`,
 * which pins the chart's own scoping beside it; it does not import from here
 * only because that file sits exactly on the 500-LOC ratchet cap.
 */
export function hasReferenceArmOutcomes(reference: TransportOutcomeSummary): boolean {
	return reference.sent > 0;
}

/**
 * Whether this cell has a live reference arm, for callers that do not already
 * hold the window's outcome summaries.
 */
export async function loadReferenceArmPresence(
	ctx: RampReadCtx,
	args: { readonly organizationId: string; readonly cell: DeliverabilityCell; readonly now: number }
): Promise<boolean> {
	const summary = await summarizeTransportOutcomes(ctx.db, {
		organizationId: args.organizationId,
		cell: deliverabilityCellKey(args.cell),
		arm: 'reference',
		since: args.now - RAMP_REFERENCE_ARM_WINDOW_MS,
	});
	return hasReferenceArmOutcomes(summary);
}

/**
 * THIS CELL'S SUBSTITUTION RESOLUTION, assembled for the callers that do not
 * already hold the tick's presence map.
 *
 * `loadCellInput` builds its own because it has the window's outcome summaries
 * in hand and must not read them a second time. The OPERATOR's doors — a
 * promotion, a phase reset — hold neither, and each of them assembling the
 * presence map itself is how two doors come to answer differently about which
 * actuator a cell is on. Assembling reads nothing that decides anything: the
 * fold is still the table's, and this is still only its read half.
 */
export async function loadCellDegradation(
	ctx: RampReadCtx,
	args: { readonly organizationId: string; readonly cell: DeliverabilityCell; readonly now: number }
): Promise<RampDegradation> {
	const presence = withReferenceArm(
		await loadRampDeploymentPresence(ctx, { organizationId: args.organizationId, now: args.now }),
		await loadReferenceArmPresence(ctx, args)
	);
	return resolveRampDegradation({ presence, provider: args.cell.destinationProvider });
}
