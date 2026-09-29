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
	 * Adapters only REPORT this fact (see {@link isAmbiguousPostDispatchTimeout});
	 * `sendProviderDispatch` decides what it means from the catalog. It retries
	 * only a kind that deduplicates on an idempotency key AND only when the
	 * extras carry one; otherwise the result is terminal, and a kind declaring
	 * `acceptanceSemantics: 'unknown-on-timeout'` gets `acceptanceUnknown: true`
	 * stamped on it so the governed boundary can park the Send.
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

/** Lower bound on any provider- or MTA-supplied retry delay. */
export const RETRY_AFTER_MIN_MS = 1_000;
/** Upper bound on any provider- or MTA-supplied retry delay. */
export const RETRY_AFTER_MAX_MS = 3_600_000;
/**
 * The wait for a deferral WE decided locally (a missing MTA configuration, an
 * unreadable decision answer, a lease we could not mint) rather than one a
 * receiver or the MTA asked for.
 */
export const LOCAL_DEFER_MS = 60_000;

/**
 * Bound a retry delay to `[RETRY_AFTER_MIN_MS, RETRY_AFTER_MAX_MS]`. The one
 * clamp every site that turns a remote answer into a schedule goes through.
 * An absent or non-finite value takes `fallbackMs`, which is clamped as well.
 */
export function clampRetryAfterMs(ms: number | undefined, fallbackMs: number): number {
	const value = ms !== undefined && Number.isFinite(ms) ? ms : fallbackMs;
	return Math.min(Math.max(value, RETRY_AFTER_MIN_MS), RETRY_AFTER_MAX_MS);
}

/** Parse a bounded RFC 9110 Retry-After delta-seconds value. */
export function parseRetryAfterDeltaMs(headerValue: string | null): number | undefined {
	if (headerValue === null) return undefined;
	const seconds = Number(headerValue.trim());
	if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
	// `seconds` is finite and positive, so the only non-finite product is an
	// overflow: an absurdly long wait, which the upper bound already answers.
	return clampRetryAfterMs(Math.round(seconds * 1_000), RETRY_AFTER_MAX_MS);
}

/**
 * Was this send failure an ambiguous post-dispatch timeout, i.e. did the
 * request possibly reach the provider before we stopped waiting for the answer?
 *
 * Covers the adapter's own `withTimeout` `sentinel` message plus the runtime's
 * native timeout/abort signals. A definite refusal that never reached
 * acceptance (`ECONNREFUSED`, an explicit 5xx body) is not ambiguous and must
 * stay the retryable `SERVER_ERROR`: broadening this predicate would turn safe
 * retries into dropped mail.
 */
export function isAmbiguousPostDispatchTimeout(
	name: string | undefined,
	message: string,
	sentinel: string
): boolean {
	if (message === sentinel) return true;
	const lowerName = (name ?? '').toLowerCase();
	if (lowerName === 'timeouterror' || lowerName === 'aborterror') return true;
	const lower = message.toLowerCase();
	return (
		lower.includes('timed out') ||
		lower.includes('timeout') ||
		lower.includes('etimedout') ||
		lower.includes('socket hang up')
	);
}
