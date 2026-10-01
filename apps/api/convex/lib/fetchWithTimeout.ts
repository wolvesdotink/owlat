/**
 * `fetch` with a deadline.
 *
 * A bare `fetch` in a Convex action has no deadline of its own: a peer that
 * accepts the connection and never answers holds the action until the runtime
 * kills it, and whatever the action was about to record (a send outcome, a scan
 * verdict) is never written. Every outbound request in this backend therefore
 * carries an `AbortSignal.timeout`, and the budget is chosen per CALL TYPE from
 * {@link FETCH_TIMEOUTS} so the reasoning sits in one place.
 *
 * The signal covers the whole exchange, body included: a `res.json()` still
 * streaming when the budget runs out rejects too. A timeout rejects with a
 * `TimeoutError` whose message names the budget (the platform's own
 * "The operation was aborted due to timeout" says neither what nor how long);
 * every other failure propagates unchanged, so callers keep their existing
 * catch blocks.
 *
 * Runtime-neutral: no Node imports, usable from both the default runtime and
 * `'use node'` actions.
 */

/**
 * Budgets per call type, in milliseconds. A budget is the point past which the
 * peer is treated as hung, not a latency target: each one sits above the
 * slowest HONEST answer the peer can give, because a timeout on a request the
 * peer did complete is worse than waiting (a send marked failed that went out,
 * a scan skipped that would have come back clean).
 */
export const FETCH_TIMEOUTS = {
	/**
	 * Small control-plane pushes to our own services on the private network
	 * (MTA mailbox/alias cache, suppression mirror). The MTA answers these from
	 * Redis in milliseconds.
	 */
	internalPush: 10_000,
	/**
	 * One POST to the MTA's `/send/postbox` intake. The MTA validates and queues;
	 * delivery happens later. The body can carry ~14 MB of base64 attachments,
	 * hence more room than a control push.
	 */
	mtaIntake: 30_000,
	/**
	 * One `/scan/attachment` POST. The MTA gives clamd 5 s to connect and 30 s to
	 * scan (`apps/mta/src/routes/scan.ts`), so anything shorter here would turn
	 * a slow but real scan into a fail-open skip.
	 */
	attachmentScan: 35_000,
	/**
	 * mail-sync `/send`: credentials, the raw `.eml` fetch and a synchronous SMTP
	 * relay through the user's own provider. SMTP's data phase may legitimately
	 * take minutes, and a timeout here records the send as failed, so this is
	 * generous; it still ends well inside Convex's 10-minute action limit, which
	 * is what used to end a hung relay (leaving the message `queued` forever).
	 */
	externalSend: 300_000,
	/**
	 * mail-sync `/test`: an IMAP login and an SMTP login, run in parallel by the
	 * worker. ImapFlow's own connection timeout is 90 s and the SMTP client's
	 * connect/greeting/command budgets are 30 s each, so the worker reports a
	 * precise error first and this is only the backstop.
	 */
	externalProbe: 120_000,
	/**
	 * Third-party REST APIs answering a single small request: Google's token
	 * endpoint, Twilio, the WhatsApp Graph API.
	 */
	thirdPartyApi: 15_000,
	/**
	 * Bulk pages against our own MTA: the suppression reconcile's 1,000-entry
	 * bulk writes and 10,000-entry export pages.
	 */
	bulkSync: 60_000,
} as const;

/** The rejection a request that ran out of budget produces. */
export class FetchTimeoutError extends Error {
	override readonly name = 'TimeoutError';
	constructor(readonly timeoutMs: number) {
		super(`Request timed out after ${timeoutMs} ms`);
	}
}

/** True for a {@link fetchWithTimeout} deadline, or the platform's own `AbortSignal.timeout` rejection. */
export function isFetchTimeout(error: unknown): boolean {
	return error instanceof Error && error.name === 'TimeoutError';
}

/**
 * `fetch(input, init)` aborted after `timeoutMs`. The caller's `init` is passed
 * through unchanged except for `signal`, which this owns.
 */
export async function fetchWithTimeout(
	input: string | URL,
	init: Omit<RequestInit, 'signal'>,
	timeoutMs: number
): Promise<Response> {
	try {
		return await fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
	} catch (error) {
		if (isFetchTimeout(error)) throw new FetchTimeoutError(timeoutMs);
		throw error;
	}
}
