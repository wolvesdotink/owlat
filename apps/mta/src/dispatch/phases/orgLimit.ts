/**
 * Phase: per-organization send rate limit.
 *
 * Defers the attempt when the org has hit its daily or hourly send cap.
 * The helper's `retryAfter` (next-hour-or-day rollover) sets the delay.
 *
 * Note: this phase increments the org's daily/hourly counters as a
 * side effect of the check — successive `defer` outcomes from later
 * phases will not roll back the increment (matches pre-deepening
 * behavior).
 */

import * as orgLimits from '../../intelligence/orgLimits.js';
import type { Phase } from '../pipeline.js';
import type { BasePhaseCtx } from '../types.js';

export const orgLimitPhase: Phase<BasePhaseCtx, BasePhaseCtx> = {
	name: 'org_limit',
	async run(deps, ctx) {
		const limitCheck = await orgLimits.checkAndIncrement(deps.redis, ctx.job.organizationId);
		if (!limitCheck.allowed) {
			return {
				kind: 'defer',
				delayMs: limitCheck.retryAfter ?? 60_000,
				reason: `Organization ${ctx.job.organizationId} rate limit reached`,
			};
		}
		return { kind: 'continue', ctx };
	},
};
