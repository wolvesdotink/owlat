/**
 * The lost-send sweep's third pass: Sends a transport took custody of whose
 * delivery report can never arrive.
 *
 * The deadline pass never touches a Send with a provider message id, because
 * provider feedback settles it. That holds only while feedback can arrive. A
 * built-in MTA Send stays `queued` after the MTA accepts it, until the MTA
 * reports delivery, bounce or expiry over its signed webhook; with the
 * webhook key unset every such report is rejected, so the Send stays `queued`
 * forever and its campaign never completes. This pass ends those Sends once
 * they are past the same deadline and grace the deadline pass uses, and only
 * while the Send's own transport has a feedback channel whose key is unset. A
 * transport with no feedback channel at all, or one whose key is set, is left
 * to its reports.
 *
 * The outcome is `failed` with its own code and a sentence that says what is
 * known: the transport accepted the message, and whether it was delivered is
 * not. It is the same honest answer the deadline pass gives for a lost
 * completion.
 *
 * Not a Convex function module.
 */

import { isSendProviderKind } from '../lib/sendProviders/types';
import { missingFeedbackVariables } from '../lib/sendProviders/feedbackReadiness';

export const NO_FEEDBACK_ERROR_CODE = 'SEND_FEEDBACK_UNAVAILABLE';

/** The sentence a Send ended by this pass carries, naming the unset keys. */
export function noFeedbackMessage(variables: readonly string[]): string {
	return `The transport accepted this send, but no delivery report could ever reach it: ${variables.join(', ')} is not set, so the webhook rejects every report. The message may or may not have been delivered`;
}

/**
 * The unset feedback keys of the transport a Send went out through, or an
 * empty list when its reports can arrive (or it records no transport).
 */
export function unreachableFeedbackVariables(send: { providerType?: string }): string[] {
	const kind = send.providerType;
	if (kind === undefined || !isSendProviderKind(kind)) return [];
	return missingFeedbackVariables(kind);
}
