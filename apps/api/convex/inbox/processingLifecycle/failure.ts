/**
 * Inbox processing lifecycle — what a `failed` message remembers about its
 * failure, and what leaving `failed` tidies up. Pure; split out of
 * `./reducers.ts` to hold it under the size cap.
 *
 * `failedStage` tells a failed send of an approved reply apart from a failed
 * agent step, so Retry can send the approved text again instead of letting the
 * agent draft over it (#1220, `@owlat/shared/inboxRetry`).
 */

import type { Doc } from '../../_generated/dataModel';
import type { ProcessingStatus, TransitionInput, TransitionParts } from './types';

/**
 * The stage a `→ failed` transition records. Only an `approved` message is
 * sending, so a failure from there is the send's. A second failure while the
 * message is already `failed` (a late step) keeps the stage of the first.
 */
export function failedStageFor(
	message: Doc<'inboundMessages'>
): Doc<'inboundMessages'>['failedStage'] {
	if (message.processingStatus === 'failed') return message.failedStage;
	return message.processingStatus === 'approved' ? 'send' : 'pipeline';
}

/**
 * The patch and effects for leaving `failed`. The stage described the failure
 * that is now over. A person moving the message on (back to review, or sending
 * the approved reply again) ends the agent's retries too: its failed step rows
 * close as `abandoned`, so the retry cron neither re-runs the agent over the
 * person's reply nor keeps scanning rows whose message has moved on. The cron's
 * own `→ received` resets its step instead.
 */
export function leaveFailedParts(
	message: Doc<'inboundMessages'>,
	input: TransitionInput
): TransitionParts {
	const from = message.processingStatus as ProcessingStatus;
	if (from !== 'failed' || input.to === 'failed') return { patch: {}, effects: [] };
	return {
		patch: { failedStage: undefined },
		effects:
			input.to === 'received'
				? []
				: [{ kind: 'abandon_failed_actions', inboundMessageId: message._id }],
	};
}
