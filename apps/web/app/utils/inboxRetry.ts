import {
	inboxRetryPlan,
	type InboxRetryFacts,
	type InboxRetryPlan,
} from '@owlat/shared/inboxRetry';

/**
 * What Retry will do with a failed Team inbox message, as i18n keys (#1220).
 * The plan comes from the same rule the server applies
 * (`inbox/mutations.retryFailedMessage`), so the button never promises a
 * re-send the server turns into a re-draft, or the other way round.
 */
export interface InboxRetryCopy {
	plan: InboxRetryPlan;
	/** Heading of the failure notice. */
	title: string;
	/** The Retry button's label. */
	action: string;
	/** One line under the button saying what happens. */
	hint: string;
}

export function inboxRetryCopy(message: InboxRetryFacts): InboxRetryCopy {
	const plan = inboxRetryPlan(message);
	return {
		plan,
		title:
			message.failedStage === 'send'
				? 'dashboard.inbox.retry.sendFailed'
				: 'dashboard.inbox.detail.processingFailed',
		action: `dashboard.inbox.retry.${plan}.action`,
		hint: `dashboard.inbox.retry.${plan}.hint`,
	};
}

/**
 * The toast after Retry went through, keyed by the plan the server reports it
 * took. A backend from before #1220 reports none and still re-drafts every
 * message, so the toast then stays neutral rather than guess.
 */
export function inboxRetryToast(taken: InboxRetryPlan | undefined): string {
	return taken ? `dashboard.inbox.retry.${taken}.toast` : 'dashboard.inbox.retry.started';
}
