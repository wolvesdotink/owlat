/**
 * THE ONE PACED WARMING PROJECTION — one projection, one population, one answer.
 *
 * `warmingCapacity.ts` answers "how much campaign volume can this deployment
 * send per day, off the published base schedule". THIS module answers the same
 * question with the pace actuator's dial applied, and it is the ONLY place that
 * dial meets that projection.
 *
 * WHY IT IS ONE PLACE. Three consumers read the campaign capacity projection and
 * all three have to agree, because they are three views of a single fact:
 *
 *   · `campaigns/capacityPreflight.ts` — the BINDING gate. It refuses a send it
 *     can prove will not finish inside `GOVERNED_MTA_MAX_MESSAGE_AGE_MS`.
 *   · `campaigns/sendPlanQueries.ts` — the multi-day walker's day budget. It is
 *     what actually meters the send.
 *   · `analytics/reputationQueries.ts` — the operator-facing send estimate.
 *
 * If only the walker were dialed, a retreated dial would make the walk take
 * several times as many days as the pre-flight sized it for — and the tail the
 * gate blessed would expire at the retention horizon, which is the exact failure
 * the multi-day plan exists to prevent. The delivery screen would meanwhile
 * quote a day count the walker cannot hit. `reputationQueries.ts` carries a
 * comment about the last time this repo let those numbers disagree; this module
 * is why it cannot happen again.
 *
 * WHAT IS DELIBERATELY *NOT* DIALED: `delivery/rampCapacityInputs.ts`. That is
 * the CONTROLLER'S OWN capacity ceiling, and it must read the UNDIALED
 * projection — a controller whose input moves every time its output moves is a
 * feedback loop, and a retreat would shrink the ceiling that justifies the next
 * retreat.
 *
 * ABSENCE IS A SUPPORTED CONFIGURATION (plan D2): no organization, no dial, an
 * unreadable dial — every one of them returns the projection untouched, and the
 * campaign behaves exactly as it did before the dial existed.
 */

import type { MutationCtx, QueryCtx } from '../_generated/server';
import { getSingletonOrganizationId } from '../lib/sessionOrganization';
import { applyPaceToCapacityByDay, loadCampaignPaceMultiplier } from './rampPaceInputs';
import { PACE_INITIAL_MULTIPLIER } from './ramp/paceConfig';
import {
	loadWarmingCapacity,
	type WarmingCapacityOptions,
	type WarmingCapacityProjection,
} from './warmingCapacity';

type Ctx = MutationCtx | QueryCtx;

/**
 * The campaign warming projection with the pace dial applied.
 *
 * `null` means exactly what `loadWarmingCapacity`'s `null` means — capacity
 * UNKNOWN — and every caller maps it onto "allow the send" exactly as before.
 * The dial never turns a known projection into an unknown one.
 */
export async function loadPacedWarmingCapacity(
	ctx: Ctx,
	options: WarmingCapacityOptions
): Promise<WarmingCapacityProjection | null> {
	const projection = await loadWarmingCapacity(ctx, options);
	if (projection === null) return null;
	const multiplier = await loadCampaignPaceMultiplier(ctx, {
		organizationId: await resolveOrganizationId(ctx),
		stream: 'campaign',
	});
	// The unmodified dial is the overwhelmingly common reading, and it must not
	// cost the projection a rebuild — nor round it.
	if (multiplier >= PACE_INITIAL_MULTIPLIER) return projection;
	const [remainingToday] = applyPaceToCapacityByDay([projection.remainingToday], multiplier);
	return {
		byDay: applyPaceToCapacityByDay(projection.byDay, multiplier),
		// Both halves of the projection are dialed by the SAME multiplier: they are
		// two questions about one population, and dialing one alone is how "fits
		// today" and "takes four days" end up describing different deployments.
		remainingToday: remainingToday ?? projection.remainingToday,
	};
}

/**
 * The singleton organization, or `''` when there is none yet.
 *
 * A fresh install with no organization is a supported configuration and not an
 * error: no row can match the empty id, so the dial reads as unmodified and the
 * projection passes through (plan D2).
 */
async function resolveOrganizationId(ctx: Ctx): Promise<string> {
	try {
		return await getSingletonOrganizationId(ctx);
	} catch {
		return '';
	}
}
