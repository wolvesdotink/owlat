/**
 * The model output a verifier budget deferral stored (D1, Sol r3 F4).
 *
 * When spend admission refuses the verifier, the run stores the validated
 * model output it could not check on its extraction row
 * (`budgetDeferredOutput`, sealed like the payload). The retry, once its
 * backoff is due, verifies that output instead of asking the model again, so a
 * deferred verification never pays for the extraction twice. Any later write
 * of the row clears it.
 */

import { v } from 'convex/values';
import { internalQuery } from '../../_generated/server';
import { openMessageBody } from '../../lib/messageBody';

/** The stored output as JSON, or null when there is none or it cannot be opened. */
export const readDeferredOutput = internalQuery({
	args: { interpretationId: v.id('messageInterpretations') },
	returns: v.union(v.string(), v.null()),
	handler: async (ctx, args) => {
		const row = await ctx.db.get(args.interpretationId);
		if (!row?.budgetDeferredOutput) return null;
		try {
			return await openMessageBody(row.budgetDeferredOutput);
		} catch {
			return null;
		}
	},
});
