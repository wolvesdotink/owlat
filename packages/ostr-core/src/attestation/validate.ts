/**
 * Structural validation of an attestation envelope (plan §5).
 *
 * A log validates form and signatures, not truth (plan §4.1), and this module
 * is the form half: it decides whether a document is a well-formed `v: 1`
 * attestation, never whether its claims hold. Signature verification is
 * {@link verifyAttestationSignature} — a document can be perfectly valid here
 * and signed by the wrong key.
 *
 * All errors are collected rather than thrown at the first one: a submitter
 * that gets one message per round-trip fixes records one round-trip at a time.
 *
 * Out of scope for v1, deliberately, and carried into the Wave 2 registry and
 * observer work rather than smuggled in here:
 *
 * - §7.3's rule that a `spam-report-batch` is admissible only alongside the
 *   same observer's `traffic-summary` for the same window is a CROSS-document
 *   rule; validation is single-document by construction. The scoring policy
 *   substitutes a denominator floor, which bounds the same attack loosely.
 * - §7.4's k-anonymity publication threshold binds the observer that publishes,
 *   not the log that accepts: a window below the threshold is well-formed, and
 *   the registry cannot tell it from a genuinely quiet one.
 * - `key-observation.publicKey` is accepted in both defined spellings (base64
 *   SPKI DER and `sha256:<hex>`). Cross-observer key agreement at challenge
 *   time (§7.5) is therefore decided by {@link normalizeObservedKey}, never by
 *   equality of the signed string.
 */
import type { Attestation, AttestationKind } from '../types.js';
import { BODY_VALIDATORS } from './bodies.js';
import { ATTESTATION_SIGNATURE_PREFIX, isAttestationSignature } from './sign.js';
import {
	isChronological,
	isFqdn,
	isIpAddress,
	isRecord,
	isRfc3339,
	unknownKeys,
} from './fields.js';

/** The `v: 1` envelope. Anything else is an unknown field. */
const ENVELOPE_FIELDS = ['v', 'kind', 'observer', 'subject', 'window', 'body', 'sig'] as const;

export const ATTESTATION_KINDS = Object.keys(BODY_VALIDATORS).sort() as readonly AttestationKind[];

/**
 * Kinds whose body is a claim ABOUT a period and is meaningless without one:
 * a count with no window cannot be turned into a rate (plan §5, §6.2).
 */
export const WINDOW_REQUIRED_KINDS: readonly AttestationKind[] = [
	'traffic-summary',
	'spam-report-batch',
	'trap-hit',
];

export type AttestationValidation =
	| { ok: true; attestation: Attestation }
	| { ok: false; errors: string[] };

export function isAttestationKind(value: unknown): value is AttestationKind {
	return typeof value === 'string' && Object.hasOwn(BODY_VALIDATORS, value);
}

function validateSubject(value: unknown, errors: string[]): void {
	if (!isRecord(value)) {
		errors.push('subject must be an object with a domain, an ip, or both');
		return;
	}
	for (const key of unknownKeys(value, ['domain', 'ip'])) {
		errors.push(`subject.${key} is not a defined field`);
	}
	const domain = value['domain'];
	const ip = value['ip'];
	if (domain === undefined && ip === undefined) {
		errors.push('subject must carry a domain, an ip, or both');
	}
	if (domain !== undefined && !isFqdn(domain)) {
		errors.push('subject.domain must be a lowercase FQDN');
	}
	if (ip !== undefined && !isIpAddress(ip)) {
		errors.push('subject.ip must be an IPv4 or canonical IPv6 address');
	}
}

function validateWindow(value: unknown, errors: string[]): void {
	if (!isRecord(value)) {
		errors.push('window must be an object with from and to');
		return;
	}
	for (const key of unknownKeys(value, ['from', 'to'])) {
		errors.push(`window.${key} is not a defined field`);
	}
	const from = value['from'];
	const to = value['to'];
	if (!isRfc3339(from)) errors.push('window.from must be an RFC 3339 timestamp');
	if (!isRfc3339(to)) errors.push('window.to must be an RFC 3339 timestamp');
	if (isRfc3339(from) && isRfc3339(to) && !isChronological(from, to)) {
		errors.push('window.from must not be after window.to');
	}
}

function validateSignatureShape(value: unknown, errors: string[]): void {
	if (typeof value !== 'string' || !value.startsWith(ATTESTATION_SIGNATURE_PREFIX)) {
		errors.push(`sig must be "${ATTESTATION_SIGNATURE_PREFIX}<base64>"`);
		return;
	}
	if (!isAttestationSignature(value)) {
		errors.push('sig must carry a base64 64-byte ed25519 signature');
	}
}

/**
 * Validate an arbitrary value as a signed `v: 1` attestation: envelope shape,
 * observer and subject identity forms, window ordering, the per-kind body, and
 * the SHAPE of `sig`. Unknown fields are rejected at every level — a log entry
 * is permanent and signed, so unscored payload does not get to ride along.
 */
export function validateAttestation(value: unknown): AttestationValidation {
	const errors: string[] = [];
	if (!isRecord(value)) {
		return { ok: false, errors: ['attestation must be a JSON object'] };
	}
	for (const key of unknownKeys(value, ENVELOPE_FIELDS)) {
		errors.push(`${key} is not a field of a v1 attestation`);
	}
	if (value['v'] !== 1) errors.push('v must be 1');

	const kind = value['kind'];
	if (!isAttestationKind(kind)) {
		errors.push('kind must be a known attestation kind');
	}
	if (!isFqdn(value['observer'])) {
		errors.push('observer must be a lowercase FQDN');
	}
	validateSubject(value['subject'], errors);

	const window = value['window'];
	if (window !== undefined) {
		validateWindow(window, errors);
	} else if (isAttestationKind(kind) && WINDOW_REQUIRED_KINDS.includes(kind)) {
		errors.push(`window is required for kind ${kind}`);
	}

	const body = value['body'];
	if (!isRecord(body)) {
		errors.push('body must be an object');
	} else if (isAttestationKind(kind)) {
		BODY_VALIDATORS[kind](body, errors);
	}
	validateSignatureShape(value['sig'], errors);

	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, attestation: value as unknown as Attestation };
}
