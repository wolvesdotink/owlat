import { GOVERNED_MTA_MAX_MESSAGE_AGE_MS } from '@owlat/shared';

type OptionalEnv = (key: string, defaultValue: string) => string;
type GovernedCapacityEnv = 'SMTP_OUTCOME_JOURNAL_MAX_SIZE' | 'WEBHOOK_DLQ_MAX_SIZE';

const DEFAULT_GOVERNED_CAPACITY = '10000';
const MAX_GOVERNED_CAPACITY = 1_000_000;

const FBL_DEDUP_PROTOCOL = 'owned-v2';
const FBL_DEDUP_FRESH_INSTALL_ACK = 'fresh-install';
const FBL_DEDUP_QUIESCED_CUTOVER_ACK = 'quiesced-v1-intake';

/** Bounded configuration for governed delivery safety state. */
export interface GovernedDeliveryConfig {
	/** Max unresolved SMTP outcome reservations retained before new attempts defer. */
	smtpOutcomeJournalMaxSize: number;
	/** Max entries retained in the webhook dead-letter queue. */
	webhookDlqMaxSize: number;
	/**
	 * Maximum wall-clock age a message may keep being retried before the MTA
	 * emits a terminal expired bounce. Measured from the first enqueue.
	 */
	maxMessageAgeMs: number;
}

function loadGovernedCapacity(optionalEnv: OptionalEnv, key: GovernedCapacityEnv): number {
	const capacity = Number(optionalEnv(key, DEFAULT_GOVERNED_CAPACITY));
	if (!Number.isSafeInteger(capacity) || capacity <= 0 || capacity > MAX_GOVERNED_CAPACITY) {
		throw new Error(`${key} must be an integer between 1 and ${MAX_GOVERNED_CAPACITY}`);
	}
	return capacity;
}

/** Load governed retry-age and Redis safety-state capacity ceilings. */
export function loadGovernedDeliveryConfig(optionalEnv: OptionalEnv): GovernedDeliveryConfig {
	const fblDedupProtocol = optionalEnv('FBL_DEDUP_PROTOCOL', '');
	if (fblDedupProtocol !== FBL_DEDUP_PROTOCOL) {
		throw new Error(
			'FBL_DEDUP_PROTOCOL must be explicitly set to owned-v2; existing installations must complete the documented quiesced cutover first'
		);
	}
	const fblDedupCutoverAck = optionalEnv('FBL_DEDUP_CUTOVER_ACK', '');
	if (
		fblDedupCutoverAck !== FBL_DEDUP_FRESH_INSTALL_ACK &&
		fblDedupCutoverAck !== FBL_DEDUP_QUIESCED_CUTOVER_ACK
	) {
		throw new Error(
			'FBL_DEDUP_CUTOVER_ACK must be fresh-install or quiesced-v1-intake; never acknowledge an upgrade before all legacy FBL intake is quiesced and drained'
		);
	}

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

	const smtpOutcomeJournalMaxSize = loadGovernedCapacity(
		optionalEnv,
		'SMTP_OUTCOME_JOURNAL_MAX_SIZE'
	);
	const webhookDlqMaxSize = loadGovernedCapacity(optionalEnv, 'WEBHOOK_DLQ_MAX_SIZE');

	return {
		maxMessageAgeMs,
		smtpOutcomeJournalMaxSize,
		webhookDlqMaxSize,
	};
}
