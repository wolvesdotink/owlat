import { GOVERNED_MTA_MAX_MESSAGE_AGE_MS } from '@owlat/shared';

type OptionalEnv = (key: string, defaultValue: string) => string;

/** Configuration shared by governed retry expiry and webhook DLQ retention. */
export interface GovernedDeliveryConfig {
	/** Max entries retained in the webhook dead-letter queue. */
	webhookDlqMaxSize: number;
	/**
	 * Maximum wall-clock age a message may keep being retried before the MTA
	 * emits a terminal expired bounce. Measured from the first enqueue.
	 */
	maxMessageAgeMs: number;
}

/** Load the bounded retry-age contract and the DLQ retention ceiling. */
export function loadGovernedDeliveryConfig(optionalEnv: OptionalEnv): GovernedDeliveryConfig {
	const maxMessageAgeMs = parseInt(
		optionalEnv('MAX_MESSAGE_AGE_MS', String(GOVERNED_MTA_MAX_MESSAGE_AGE_MS)),
		10
	);
	if (
		!Number.isFinite(maxMessageAgeMs) ||
		maxMessageAgeMs <= 0 ||
		maxMessageAgeMs > GOVERNED_MTA_MAX_MESSAGE_AGE_MS
	) {
		throw new Error(`MAX_MESSAGE_AGE_MS must be between 1 and ${GOVERNED_MTA_MAX_MESSAGE_AGE_MS}`);
	}

	return {
		maxMessageAgeMs,
		webhookDlqMaxSize: parseInt(optionalEnv('WEBHOOK_DLQ_MAX_SIZE', '10000'), 10),
	};
}
