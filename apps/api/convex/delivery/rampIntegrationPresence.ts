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
import type { MutationCtx } from '../_generated/server';
import { summarizeTransportOutcomes } from '../analytics/transportOutcomes';
import type { RampIntegrationPresence } from './ramp/degradationMatrix';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How recently an integration must have produced data to count as connected.
 *
 * Generous (30 days) on purpose: these feeds are daily-to-weekly and a
 * fortnight's silence from Google Postmaster is normal for a low-volume domain.
 * The window exists to notice an integration that has genuinely stopped, not to
 * flap the ramp's constants on ordinary reporting gaps.
 */
export const RAMP_INTEGRATION_FRESHNESS_MS = 30 * DAY_MS;

/** Enrollment rows scanned when looking for a live feedback loop. */
const CFL_ENROLLMENT_SCAN_LIMIT = 20;

/**
 * The deployment-level half of the presence map. The reference transport is
 * per-CELL (a relay can carry Gmail traffic and nothing else), so it is supplied
 * by the caller that already knows the cell's reference arm.
 */
export type RampDeploymentPresence = Omit<RampIntegrationPresence, 'reference_transport'>;

export async function loadRampDeploymentPresence(
	ctx: MutationCtx,
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
		complaint_feedback_loop: enrollments.some((row) => row.state === 'enrolled'),
		// NOTHING IN THIS DEPLOYMENT INTEGRATES A COMMERCIAL PLACEMENT SERVICE, and
		// the matrix says that costs nothing — self-hosted seeds are the EXPECTED
		// configuration for placement (plan D17). Hard `false` rather than a
		// speculative credential lookup for a product we do not integrate (D20).
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
 * Whether this cell has a live reference arm, for callers that do not already
 * hold the window's outcome summaries.
 *
 * A reference arm is ABSENT, not empty, when nothing was sent through it — the
 * same rule `loadCellInput` applies to the summary it already has, expressed
 * once so the two callers cannot disagree about what "has a relay" means.
 */
export async function loadReferenceArmPresence(
	ctx: MutationCtx,
	args: { readonly organizationId: string; readonly cell: DeliverabilityCell; readonly now: number }
): Promise<boolean> {
	const summary = await summarizeTransportOutcomes(ctx.db, {
		organizationId: args.organizationId,
		cell: deliverabilityCellKey(args.cell),
		arm: 'reference',
		since: args.now - RAMP_INTEGRATION_FRESHNESS_MS,
	});
	return summary.sent > 0;
}
