'use node';

/**
 * Interpretation of a message we sent (SPEC §5 "Outbound"): a Postbox message
 * once its transport recorded `sent` (`{kind: 'outboundMail'}`), a team reply
 * once its Send was finalized (`{kind: 'teamReply'}`). Scheduled by
 * `enqueue.ts#enqueueSentInterpretation`, once per send.
 *
 * After the reducer applied, the send's failure state is read again
 * (`sendFailure.reconcile`): a bounce that landed while the model was reading
 * found nothing to take back, so the dispositions this run just set are
 * failed here instead.
 */

import { internalAction } from '../../_generated/server';
import { internal } from '../../_generated/api';
import { interpretationSourceValidator } from '../../lib/validators/threadBrief';
import { runInterpretation, type InterpretRunResult } from './run';

export const interpretSent = internalAction({
	args: { source: interpretationSourceValidator },
	handler: async (ctx, args): Promise<InterpretRunResult> => {
		const result = await runInterpretation(ctx, { source: args.source });
		if (result.status === 'complete' || result.status === 'partial') {
			await ctx.runMutation(internal.mail.interpret.sendFailure.reconcile, {
				source: args.source,
			});
		}
		return result;
	},
});
