/**
 * Phase: recipient suppression check.
 *
 * Drops the attempt (no retry) if the recipient is on the MTA suppression
 * list. The suppression list is auto-populated on hard bounces and
 * complaints — sending to a suppressed address would damage IP reputation.
 *
 * It also withdraws queued marketing mail to a recipient who unsubscribed
 * after the message was handed to this MTA (`intelligence/marketingOptOut.ts`).
 */

import * as suppressionList from '../../intelligence/suppressionList.js';
import { isWithdrawnByMarketingOptOut } from '../../intelligence/marketingOptOut.js';
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
		if (await isWithdrawnByMarketingOptOut(deps.redis, ctx.job)) {
			return { kind: 'drop', status: 'unsubscribed', reason: 'recipient_unsubscribed' };
		}
		return { kind: 'continue', ctx };
	},
};
