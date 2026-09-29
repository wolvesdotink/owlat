import { GOVERNED_MTA_MAX_MESSAGE_AGE_MS } from '@owlat/shared';
import { readIntEnv, type IntEnvOptions } from '@owlat/shared/nodeEnv';

type OptionalEnv = (key: string, defaultValue: string) => string;
type GovernedCapacityEnv = 'SMTP_OUTCOME_JOURNAL_MAX_SIZE' | 'WEBHOOK_DLQ_MAX_SIZE';

const DEFAULT_GOVERNED_CAPACITY = 10_000;
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

/**
 * Validated integer read through the caller's `optionalEnv`. An empty value is
 * passed as the fallback so readIntEnv treats unset and blank alike.
 */
function readGovernedInt(optionalEnv: OptionalEnv, key: string, options: IntEnvOptions): number {
	return readIntEnv({ [key]: optionalEnv(key, '') }, key, options);
}

function loadGovernedCapacity(optionalEnv: OptionalEnv, key: GovernedCapacityEnv): number {
	return readGovernedInt(optionalEnv, key, {
		default: DEFAULT_GOVERNED_CAPACITY,
		min: 1,
		max: MAX_GOVERNED_CAPACITY,
	});
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

	const maxMessageAgeMs = readGovernedInt(optionalEnv, 'MAX_MESSAGE_AGE_MS', {
		default: GOVERNED_MTA_MAX_MESSAGE_AGE_MS,
		min: 1,
		max: GOVERNED_MTA_MAX_MESSAGE_AGE_MS,
	});

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
