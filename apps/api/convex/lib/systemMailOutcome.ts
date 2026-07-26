import { EmailErrorCode, isRetryableErrorCode, type SendProviderKind } from './sendProviders';

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

export function systemMailRetryDisposition(
	provider: string | undefined,
	idempotencyKey: string | undefined,
	errorCode: SystemMailFailureCode
): SystemMailRetryDisposition {
	if (errorCode !== 'CONFIGURATION' && isRetryableErrorCode(errorCode)) {
		return 'safe_to_retry';
	}
	const hasProviderDeduplication =
		idempotencyKey !== undefined && (provider === 'mta' || provider === 'resend');
	return hasProviderDeduplication && errorCode === EmailErrorCode.AMBIGUOUS_TIMEOUT
		? 'safe_to_retry'
		: 'terminal';
}
