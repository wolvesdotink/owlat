/**
 * Validators for the abuse-status columns of `instanceSettings`, shared by the
 * schema and the **Abuse status (module)** that writes them.
 */

import { v } from 'convex/values';

/** The metric the reputation check suspended or warned on (`analytics/reputationEnforcement.ts`). */
export const reputationTriggerValidator = v.object({
	code: v.union(
		v.literal('bounce_rate'),
		v.literal('complaint_rate'),
		v.literal('gmail_spam_rate')
	),
	// Gmail spam rates are judged per sending domain; the internal rates have none.
	domain: v.optional(v.string()),
});

/** A platform admin's lift: these triggers do not suspend again before `until`. */
export const reputationCheckHoldValidator = v.object({
	until: v.number(),
	triggers: v.array(reputationTriggerValidator),
});
