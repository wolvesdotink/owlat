/**
 * The `posture` body: what a SUBJECT declares about itself (plan §5).
 *
 * Every field is optional — a domain declares what it has — but the body as a
 * whole must assert something, and an empty list asserts nothing. A posture
 * that declared nothing would still consume a log entry, a scoring slot and a
 * signature, which is exactly the free-standing weight this rule denies.
 */
import type { PostureBody } from '../types.js';
import { isDkimSelector, isIpAddress, isRecord, isRfc3339 } from './fields.js';
import { fieldsOf, rejectUnknown, rejectUnknownAt, type BodyValidator } from './bodyFields.js';

const POSTURE_FIELDS = fieldsOf<PostureBody>({
	dmarcPolicy: true,
	dmarcAlignment: true,
	dnssec: true,
	mtaSts: true,
	tlsRpt: true,
	declaredIps: true,
	registeredBefore: true,
	compromiseDisclosure: true,
});

const DMARC_POLICIES: readonly string[] = [
	'none',
	'quarantine',
	'reject',
] as const satisfies readonly NonNullable<PostureBody['dmarcPolicy']>[];
const DMARC_ALIGNMENTS: readonly string[] = [
	'relaxed',
	'strict',
] as const satisfies readonly NonNullable<PostureBody['dmarcAlignment']>[];

function validateEnum(
	body: Record<string, unknown>,
	key: string,
	allowed: readonly string[],
	errors: string[]
): void {
	const value = body[key];
	if (value === undefined) return;
	if (typeof value !== 'string' || !allowed.includes(value)) {
		errors.push(`body.${key} must be one of ${allowed.join(', ')}`);
	}
}

function validateOptionalBoolean(
	body: Record<string, unknown>,
	key: string,
	errors: string[]
): void {
	if (body[key] !== undefined && typeof body[key] !== 'boolean') {
		errors.push(`body.${key} must be a boolean`);
	}
}

function validateCompromiseDisclosure(value: unknown, errors: string[]): void {
	if (!isRecord(value)) {
		errors.push('body.compromiseDisclosure must be an object');
		return;
	}
	rejectUnknownAt(value, ['rotatedAt', 'affectedSelectors'], 'body.compromiseDisclosure', errors);
	if (!isRfc3339(value['rotatedAt'])) {
		errors.push('body.compromiseDisclosure.rotatedAt must be an RFC 3339 timestamp');
	}
	const selectors = value['affectedSelectors'];
	if (!Array.isArray(selectors) || selectors.length === 0 || !selectors.every(isDkimSelector)) {
		errors.push(
			'body.compromiseDisclosure.affectedSelectors must be a non-empty array of DKIM selectors'
		);
	}
}

/** An empty list declares nothing, so it does not count as a fact — otherwise
 *  `{ "declaredIps": [] }` would buy a log entry and a scoring slot for free. */
function declaresPostureFact(body: Record<string, unknown>): boolean {
	return POSTURE_FIELDS.some((field) => {
		const value = body[field];
		return value !== undefined && !(Array.isArray(value) && value.length === 0);
	});
}

/** Non-empty and duplicate-free, like every other list in this module: a
 *  repeated IP would be counted twice by anything that weighs the declaration. */
function isDeclaredIpList(value: unknown): boolean {
	if (!Array.isArray(value) || value.length === 0 || !value.every(isIpAddress)) return false;
	return new Set(value).size === value.length;
}

export const validatePosture: BodyValidator = (body, errors) => {
	rejectUnknown(body, POSTURE_FIELDS, errors);
	if (!declaresPostureFact(body)) {
		errors.push('body must declare at least one posture fact');
	}
	validateEnum(body, 'dmarcPolicy', DMARC_POLICIES, errors);
	validateEnum(body, 'dmarcAlignment', DMARC_ALIGNMENTS, errors);
	validateOptionalBoolean(body, 'dnssec', errors);
	validateOptionalBoolean(body, 'mtaSts', errors);
	validateOptionalBoolean(body, 'tlsRpt', errors);
	const declaredIps = body['declaredIps'];
	if (declaredIps !== undefined && !isDeclaredIpList(declaredIps)) {
		errors.push('body.declaredIps must be a non-empty array of distinct IP addresses');
	}
	if (body['registeredBefore'] !== undefined && !isRfc3339(body['registeredBefore'])) {
		errors.push('body.registeredBefore must be an RFC 3339 timestamp');
	}
	if (body['compromiseDisclosure'] !== undefined) {
		validateCompromiseDisclosure(body['compromiseDisclosure'], errors);
	}
};
