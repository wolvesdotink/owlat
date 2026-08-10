import { EmailErrorCode, isRetryableErrorCode, type SendProviderKind } from './sendProviders';
import { deduplicatesOnIdempotencyKeyFor, isSendProviderKind } from './sendProviders/catalog';

export type SystemMailRetryDisposition = 'safe_to_retry' | 'terminal';
export type SystemMailFailureCode = EmailErrorCode | 'CONFIGURATION';

export type SystemMailAttemptOutcome =
	| {
			status: 'accepted';
			provider: SendProviderKind;
			providerMessageId: string;
			latencyMs: number;
			attempts: number;
	  }
	| {
			status: 'failed';
			provider: SendProviderKind | null;
			errorCode: SystemMailFailureCode;
			errorMessage: string;
			retryDisposition: SystemMailRetryDisposition;
	  };

/**
 * May the caller send this system/auth mail again?
 *
 * The ambiguous case is the interesting one: an AMBIGUOUS_TIMEOUT means the
 * request may or may not have been accepted, so repeating it is safe only where
 * the transport DEDUPLICATES on the idempotency key we handed it. That used to
 * be spelled `provider === 'mta' || provider === 'resend'` — a list, and the
 * third copy of a fact `systemMail.ts` also encoded twice (an MTA arm carrying
 * the key as `messageId`, a Resend ternary carrying it as a header). The catalog
 * declares it once now, and the same declaration is what the adapters'
 * `buildSystemMailExtras` honours, so the promise and the wiring cannot drift.
 *
 * `provider` arrives as a raw string — it may be an unset env, a retired kind or
 * a plugin transport — and an unrecognized one is not a dedup surface: fail
 * closed to `terminal` rather than re-mailing a real person.
 */
export function systemMailRetryDisposition(
	provider: string | undefined,
	idempotencyKey: string | undefined,
	errorCode: SystemMailFailureCode
): SystemMailRetryDisposition {
	if (errorCode !== 'CONFIGURATION' && isRetryableErrorCode(errorCode)) {
		return 'safe_to_retry';
	}
	const hasProviderDeduplication =
		idempotencyKey !== undefined &&
		isSendProviderKind(provider) &&
		deduplicatesOnIdempotencyKeyFor(provider);
	return hasProviderDeduplication && errorCode === EmailErrorCode.AMBIGUOUS_TIMEOUT
		? 'safe_to_retry'
		: 'terminal';
}
