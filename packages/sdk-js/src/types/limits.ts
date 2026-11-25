export type {
	DailySendLimit,
	RecipientSendLimit,
	RecipientSendUsage,
	SendLimits,
} from '@owlat/public-contract';

/**
 * The template and address of `owlat.limits.get()` whose per-recipient count
 * to read. Name the template by `transactionalId` or `slug`, as in a send; the
 * ID wins when both are given.
 */
export interface GetLimitsParams {
	/** The recipient address, matched after trimming and lowercasing. */
	email: string;
	/** ID of the template. */
	transactionalId?: string;
	/** Slug of the template. */
	slug?: string;
}
