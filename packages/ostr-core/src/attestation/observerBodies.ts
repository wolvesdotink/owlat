/**
 * Bodies an OBSERVER authors about someone else (plan §5): what it saw, how
 * much of it, and which DKIM key it saw it signed with.
 *
 * These carry the counts scoring divides, so their internal consistency is
 * checked here (a subset cannot exceed its denominator) and their magnitudes
 * are bounded — a signed log entry is permanent, and an unbounded bucket is an
 * unbounded weight in an arithmetic that runs years later.
 */
import type {
	KeyObservationBody,
	SpamReportBatchBody,
	TrafficSummaryBody,
	TrapHitBody,
} from '../types.js';
import { sha256 } from '../crypto.js';
import {
	isBase64,
	isChronological,
	isCount,
	isDkimSelector,
	isFqdn,
	isRfc3339,
	isSha256Hex,
} from './fields.js';
import {
	fieldsOf,
	rejectUnknown,
	requireCount,
	requireRfc3339,
	type BodyValidator,
} from './bodyFields.js';

const TRAFFIC_SUMMARY_FIELDS = fieldsOf<TrafficSummaryBody>({
	messages: true,
	spfPass: true,
	dkimPass: true,
	dmarcPass: true,
	tlsInbound: true,
	uniqueRecipientsBucket: true,
	bounceRateBucket: true,
});

/** Counts of a subset of `messages` cannot exceed it — a denominator smaller
 *  than its numerator is the under-attestation attack of plan §7.3. */
const TRAFFIC_SUMMARY_SUBSET_FIELDS = [
	'spfPass',
	'dkimPass',
	'dmarcPass',
	'tlsInbound',
] as const satisfies readonly (keyof TrafficSummaryBody)[];

/** `uniqueRecipientsBucket` is a power-of-ten exponent (plan §7.4): 10^20
 *  recipients is already many orders of magnitude past any real mail stream. */
export const MAX_UNIQUE_RECIPIENTS_BUCKET = 20;
/** `bounceRateBucket` counts percent steps, and a rate cannot exceed 100%. */
export const MAX_BOUNCE_RATE_BUCKET = 100;

const BUCKET_CAPS = [
	['uniqueRecipientsBucket', MAX_UNIQUE_RECIPIENTS_BUCKET],
	['bounceRateBucket', MAX_BOUNCE_RATE_BUCKET],
] as const;

export const validateTrafficSummary: BodyValidator = (body, errors) => {
	rejectUnknown(body, TRAFFIC_SUMMARY_FIELDS, errors);
	for (const field of TRAFFIC_SUMMARY_FIELDS) requireCount(body, field, errors);
	for (const [field, cap] of BUCKET_CAPS) {
		const bucket = body[field];
		if (isCount(bucket) && bucket > cap) errors.push(`body.${field} must be at most ${cap}`);
	}
	const messages = body['messages'];
	if (!isCount(messages)) return;
	for (const field of TRAFFIC_SUMMARY_SUBSET_FIELDS) {
		const value = body[field];
		if (isCount(value) && value > messages) {
			errors.push(`body.${field} must not exceed body.messages`);
		}
	}
};

const SPAM_REPORT_BATCH_FIELDS = fieldsOf<SpamReportBatchBody>({
	reports: true,
	commitment: true,
});

export const validateSpamReportBatch: BodyValidator = (body, errors) => {
	rejectUnknown(body, SPAM_REPORT_BATCH_FIELDS, errors);
	requireCount(body, 'reports', errors);
	if (!isSha256Hex(body['commitment'])) {
		errors.push('body.commitment must be a lowercase hex sha256 Merkle root');
	}
};

const TRAP_HIT_FIELDS = fieldsOf<TrapHitBody>({ hits: true });

export const validateTrapHit: BodyValidator = (body, errors) => {
	rejectUnknown(body, TRAP_HIT_FIELDS, errors);
	requireCount(body, 'hits', errors);
};

/** ASN.1 SEQUENCE tag: the first byte of any SubjectPublicKeyInfo. */
const DER_SEQUENCE_TAG = 0x30;
/** The smallest real SPKI is ed25519's 44 bytes; RSA-2048 is 294. */
const MIN_SPKI_BYTES = 44;

/** Total length of the DER SEQUENCE `der` opens with, or -1 for a header that
 *  is indefinite, non-minimal or truncated — none of which DER permits. */
function derSequenceLength(der: Buffer): number {
	const first = der[1] ?? 0;
	if (first < 0x80) return 2 + first;
	const lengthBytes = first & 0x7f;
	if (lengthBytes < 1 || lengthBytes > 2) return -1;
	let length = 0;
	for (let i = 0; i < lengthBytes; i++) length = (length << 8) | (der[2 + i] ?? 0);
	if (length < 0x80 || (lengthBytes === 2 && length < 0x100)) return -1;
	return 2 + lengthBytes + length;
}

/**
 * Base64 framing a DER SubjectPublicKeyInfo: SEQUENCE tag, a length header that
 * accounts for exactly the bytes present, and enough of them to be a key.
 *
 * Plan §7.5 rests on key observations being REPLAYABLE at challenge time, so a
 * blob that will not parse then is not evidence now. The tag check also keeps a
 * hex digest from passing as "base64" and collapsing the two publicKey forms.
 */
function isSpkiDer(value: unknown): value is string {
	if (!isBase64(value)) return false;
	const der = Buffer.from(value, 'base64');
	if (der.length < MIN_SPKI_BYTES || der[0] !== DER_SEQUENCE_TAG) return false;
	return derSequenceLength(der) === der.length;
}

const OBSERVED_KEY_DIGEST_PREFIX = 'sha256:';

/** The digest spelling of an observed DKIM key, per plan §7.5. */
function isObservedKeyDigest(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.startsWith(OBSERVED_KEY_DIGEST_PREFIX) &&
		isSha256Hex(value.slice(OBSERVED_KEY_DIGEST_PREFIX.length))
	);
}

/**
 * The comparable form of a `key-observation` publicKey: `sha256:<hex>` for both
 * accepted spellings, so two observers that saw one key agree by string
 * equality at challenge time (plan §7.5) even when one logged the SPKI and the
 * other its digest. Returns null for a value this module would reject.
 */
export function normalizeObservedKey(publicKey: unknown): string | null {
	if (isObservedKeyDigest(publicKey)) return publicKey;
	if (isSpkiDer(publicKey)) {
		return OBSERVED_KEY_DIGEST_PREFIX + sha256(Buffer.from(publicKey, 'base64')).toString('hex');
	}
	return null;
}

const KEY_OBSERVATION_FIELDS = fieldsOf<KeyObservationBody>({
	domain: true,
	selector: true,
	publicKey: true,
	firstSeen: true,
	lastSeen: true,
	dnssecValidated: true,
});

export const validateKeyObservation: BodyValidator = (body, errors) => {
	rejectUnknown(body, KEY_OBSERVATION_FIELDS, errors);
	if (!isFqdn(body['domain'])) errors.push('body.domain must be a lowercase FQDN');
	if (!isDkimSelector(body['selector'])) errors.push('body.selector must be a DKIM selector');
	// Either the SPKI DER itself (base64) or its digest, per plan §7.5.
	if (normalizeObservedKey(body['publicKey']) === null) {
		errors.push('body.publicKey must be base64 SPKI DER or "sha256:<hex>"');
	}
	requireRfc3339(body, 'firstSeen', errors);
	requireRfc3339(body, 'lastSeen', errors);
	if (
		isRfc3339(body['firstSeen']) &&
		isRfc3339(body['lastSeen']) &&
		!isChronological(body['firstSeen'], body['lastSeen'])
	) {
		errors.push('body.firstSeen must not be after body.lastSeen');
	}
	if (typeof body['dnssecValidated'] !== 'boolean') {
		errors.push('body.dnssecValidated must be a boolean');
	}
};
