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
	/** The toast after Retry went through. */
	toast: string;
}

export function inboxRetryCopy(
	message: InboxRetryFacts,
	/** The plan the server reports it took; wins over the local reading. */
	taken?: InboxRetryPlan
): InboxRetryCopy {
	const plan = taken ?? inboxRetryPlan(message);
	return {
		plan,
		title:
			message.failedStage === 'send'
				? 'dashboard.inbox.retry.sendFailed'
				: 'dashboard.inbox.detail.processingFailed',
		action: `dashboard.inbox.retry.${plan}.action`,
		hint: `dashboard.inbox.retry.${plan}.hint`,
		toast: `dashboard.inbox.retry.${plan}.toast`,
	};
}
