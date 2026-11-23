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
 * The cap on sends of one template to one address. What is left depends on
 * the template and the address, so no count is given: a send over it answers
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
}

/** Body of `GET /api/v1/limits`. */
export interface SendLimits {
	dailySends: DailySendLimit;
	recipientSends: RecipientSendLimit;
}
