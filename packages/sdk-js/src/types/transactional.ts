import type { TransactionalSendStatusValue } from '@owlat/public-contract';

export type {
	SendTransactionalRequest as SendTransactionalParams,
	SendTransactionalResponse,
	SendTransactionalDryRun,
	SendRefusal,
	TransactionalAttachment,
	TransactionalSendStatus,
	TransactionalSendStatusValue,
} from '@owlat/public-contract';

/**
 * Filters and page of `owlat.transactional.list()`. Filter by `email`, by
 * `status`, or by both. The window is when the sends were queued: `until`
 * defaults to now and `since` to 30 days before it, and it can be at most 30
 * days long.
 */
export interface ListTransactionalSendsParams {
	/** Only sends to this address, matched after trimming and lowercasing. */
	email?: string;
	/** Only sends in this delivery state. */
	status?: TransactionalSendStatusValue;
	/** ISO 8601 timestamp: only sends queued at or after it. */
	since?: string;
	/** ISO 8601 timestamp: only sends queued before it. */
	until?: string;
	/** Items per page, at most 100. Defaults to 25. */
	limit?: number;
	/**
	 * The previous page's `pagination.cursor`. Pass the same filters with it:
	 * a cursor sent with other filters is refused.
	 */
	cursor?: string;
}
