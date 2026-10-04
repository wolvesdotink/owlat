/**
 * What Retry does with a failed Team inbox message (#1220).
 *
 * One rule for every caller: the manual Retry (`inbox/mutations.retryFailedMessage`,
 * from the thread page and the failed-messages page), the automatic retry cron
 * (`inbox/processingLifecycle.retryFailedActions`) and the web copy that says
 * what the button will do. Shared so the label cannot promise one thing while
 * the server does another.
 *
 * - `resend`: the send of a reply a person approved failed. The approved text
 *   is sent again, unchanged; the agent does not run.
 * - `review`: a person wrote, edited or approved the reply, but it cannot simply
 *   be sent again (the failure was not in the send, or the row predates the
 *   failure stage). The reply goes back to review with its text and saved
 *   revisions; the agent does not run.
 * - `redraft`: nobody touched the reply. The agent pipeline runs again from the
 *   security scan, as before.
 *
 * The cron only ever takes `redraft`. It never sends and never acts for a
 * person, so a failed message that holds a person's reply waits for one.
 */

export type InboxRetryPlan = 'resend' | 'review' | 'redraft';

/** The inbound-message fields the rule reads (a subset of the Convex row). */
export interface InboxRetryFacts {
	/** Where the message failed: sending the approved reply, or a pipeline step. Absent on rows that failed before the field existed. */
	failedStage?: 'send' | 'pipeline';
	/** Who made the last approval: the router (`auto`) or a person (`human`). */
	approvalSource?: 'auto' | 'human';
	draftResponse?: string;
	/** A person took the reply over from the agent. */
	manualTakeoverAt?: number;
	/** A person saved the draft. */
	draftSavedAt?: number;
	/** A person's saves over the draft. */
	draftRevisions?: readonly unknown[];
	isDraftEdited?: boolean;
}

/**
 * Did a person write, edit or approve this message's reply? Any of these marks
 * means the agent must not draft it again on its own.
 */
export function holdsHumanReply(message: InboxRetryFacts): boolean {
	return (
		message.manualTakeoverAt !== undefined ||
		message.draftSavedAt !== undefined ||
		(message.draftRevisions?.length ?? 0) > 0 ||
		message.isDraftEdited === true ||
		message.approvalSource === 'human'
	);
}

export function inboxRetryPlan(message: InboxRetryFacts): InboxRetryPlan {
	// The send failed after a person's approval and the approved text is still
	// there: send it again. An absent `approvalSource` on a send failure is read
	// as a person's, as everywhere else (only the router writes `auto`).
	if (
		message.failedStage === 'send' &&
		message.approvalSource !== 'auto' &&
		(message.draftResponse ?? '').trim() !== ''
	) {
		return 'resend';
	}
	return holdsHumanReply(message) ? 'review' : 'redraft';
}
