/** Typed outcomes and retry policy shared by send-provider adapters. */

export enum EmailErrorCode {
	/** Rate limit exceeded — retryable */
	RATE_LIMIT = 'RATE_LIMIT',
	/** Temporary server error — retryable */
	SERVER_ERROR = 'SERVER_ERROR',
	/** Invalid recipient — not retryable */
	INVALID_RECIPIENT = 'INVALID_RECIPIENT',
	/** Invalid sender domain — not retryable */
	INVALID_SENDER = 'INVALID_SENDER',
	/** Authentication failed — not retryable */
	AUTH_FAILED = 'AUTH_FAILED',
	/** Content rejected (spam, etc.) — not retryable */
	CONTENT_REJECTED = 'CONTENT_REJECTED',
	/**
	 * The send request timed out AFTER it was put on the wire, so it is
	 * ambiguous whether the provider already accepted (and delivered) it.
	 * NOT retryable: on a provider with no server-side dedup (SES), a retry
	 * of an already-accepted request would double-deliver. Used only where a
	 * surviving retry cannot be de-duped at the provider (see the SES adapter;
	 * MTA/Resend instead thread an idempotency key and stay retryable).
	 */
	AMBIGUOUS_TIMEOUT = 'AMBIGUOUS_TIMEOUT',
	/**
	 * The envelope carries a non-ASCII (RFC 6531 SMTPUTF8 / EAI) mailbox but the
	 * destination server did not advertise `SMTPUTF8`. There is no ASCII downgrade
	 * for a UTF-8 local-part, so the client fails closed rather than mangling the
	 * address — a permanent, NOT-retryable condition distinct from a generic
	 * server error.
	 */
	SMTPUTF8_UNSUPPORTED = 'SMTPUTF8_UNSUPPORTED',
	/** A last-mile safety lease changed; reschedule with a fresh decision. */
	ROUTING_DEFERRED = 'ROUTING_DEFERRED',
	/**
	 * The MTA could not READ the routing lease it had granted — a truncated or
	 * corrupt record in its own store, not a lease that aged out or stopped
	 * binding. Reschedules exactly like `ROUTING_DEFERRED`; it is a separate code
	 * because it is a separate CLAIM. `ROUTING_DEFERRED` says the MTA declined
	 * this sending identity, and gate 2 halts a cell at 25% of those; this one
	 * says our own storage failed with no receiver involved, so
	 * `delivery/governedDispatch.ts` marks its deferral `local` and the gate does
	 * not count it (issue #505). The wire code is
	 * `ROUTING_LEASE_UNREADABLE_CODE` in `@owlat/shared`.
	 */
	ROUTING_LEASE_UNREADABLE = 'ROUTING_LEASE_UNREADABLE',
	/** Unknown error */
	UNKNOWN = 'UNKNOWN',
}

export type EmailSendAttempt =
	| { success: true; id: string }
	| {
			success: false;
			errorMessage: string;
			errorCode: EmailErrorCode;
			retryAfterMs?: number;
			/** MTA request outcome is unknown because no HTTP response was observed. */
			acceptanceUnknown?: true;
	  };

/**
 * Map a transport-level HTTP status to a typed `EmailErrorCode`, or
 * `undefined` when the status carries no definitive classification (the
 * caller then falls back to provider-specific message parsing).
 *
 * Shared status → code prelude across the MTA/SES/Resend `categorizeError`
 * methods: `429 → RATE_LIMIT`, `5xx → SERVER_ERROR`, `401/403 → AUTH_FAILED`.
 * Only providers that surface an HTTP status (the MTA today) reach the
 * 401/403 branch; SES/Resend never pass a status, so this only folds the
 * shared prelude and leaves each provider's own error parsing intact.
 */
export function httpStatusToErrorCode(status: number): EmailErrorCode | undefined {
	if (status === 429) return EmailErrorCode.RATE_LIMIT;
	if (status >= 500) return EmailErrorCode.SERVER_ERROR;
	if (status === 401 || status === 403) return EmailErrorCode.AUTH_FAILED;
	return undefined;
}

/**
 * Retry predicate over the typed error code. The dispatch helper retries
 * on `RATE_LIMIT` and `SERVER_ERROR`; everything else is terminal.
 */
export function isRetryableErrorCode(code: EmailErrorCode): boolean {
	return code === EmailErrorCode.RATE_LIMIT || code === EmailErrorCode.SERVER_ERROR;
}

/** Parse a bounded RFC 9110 Retry-After delta-seconds value. */
export function parseRetryAfterDeltaMs(headerValue: string | null): number | undefined {
	if (headerValue === null) return undefined;
	const seconds = Number(headerValue.trim());
	if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
	return Math.min(Math.max(Math.round(seconds * 1_000), 1_000), 3_600_000);
}
