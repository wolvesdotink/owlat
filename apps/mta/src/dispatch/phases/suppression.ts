/**
 * Phase: recipient suppression check.
 *
 * Drops the attempt (no retry) if the recipient is on the MTA suppression
 * list. The suppression list is auto-populated on hard bounces and
 * complaints — sending to a suppressed address would damage IP reputation.
 */

import * as suppressionList from '../../intelligence/suppressionList.js';
import type { Phase } from '../pipeline.js';
import type { BasePhaseCtx } from '../types.js';

export const suppressionPhase: Phase<BasePhaseCtx, BasePhaseCtx> = {
	name: 'suppression',
	async run(deps, ctx) {
		if (await suppressionList.isSuppressed(deps.redis, ctx.job.to)) {
			return {
				kind: 'drop',
				status: 'suppressed',
				reason: 'recipient_suppressed',
			};
		}
		return { kind: 'continue', ctx };
	},
};
