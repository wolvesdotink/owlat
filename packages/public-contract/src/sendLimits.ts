/**
 * The body of `GET /api/v1/limits`: the transactional send limits that apply
 * to the asking key, and what is left of them. Plain TypeScript with no
 * imports, re-exported by `types.ts`; see there for why.
 */

/** The cap on sends per API key and UTC day, and the asking key's count. */
export interface DailySendLimit {
	/** Whether the instance admin has the cap on. */
	isEnabled: boolean;
	/** Sends allowed per key and UTC day; kept while the cap is off. */
	limit: number;
	/** Sends counted against this key today; `null` while the cap is off, since none are counted. */
	used: number | null;
	/** Sends this key may still make today, never below 0; `null` while the cap is off. */
	remaining: number | null;
	/** ISO 8601 time the count starts again (the next UTC midnight); `null` while the cap is off. */
	resetsAt: string | null;
}

/**
 * What one template sent to one address under the per-recipient cap. Given
 * only when the request names both.
 */
export interface RecipientSendUsage {
	/** The address, trimmed and lowercased as the send route stores it. */
	email: string;
	/** ID of the template. */
	templateId: string;
	/** Slug of the template. */
	slug: string;
	/** Whether the template is exempt from the cap; then nothing is counted. */
	isExempt: boolean;
	/** Sends counted against the pair now, rounded up; `null` while the cap is off or the template is exempt. */
	used: number | null;
	/** Sends of the template to the address that fit now, never below 0; `null` while the cap is off or the template is exempt. */
	remaining: number | null;
	/** ISO 8601 time the count is back to zero; `null` when nothing is counted. */
	resetsAt: string | null;
}

/**
 * The cap on sends of one template to one address. A send over it answers
 * `429` with `Retry-After`. The allowance refills continuously, `limit` per
 * window. A template can be exempt from it.
 */
export interface RecipientSendLimit {
	/** Whether the instance admin has the cap on. */
	isEnabled: boolean;
	/** Sends allowed per template and address within the window. */
	limit: number;
	/** Length of the window, in seconds. */
	windowSeconds: number;
	/** The count for the template and address the request named, when it named both. */
	usage?: RecipientSendUsage;
}

/** Body of `GET /api/v1/limits`. */
export interface SendLimits {
	dailySends: DailySendLimit;
	recipientSends: RecipientSendLimit;
}
