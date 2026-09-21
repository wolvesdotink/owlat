/**
 * The primitives every per-kind body validator is built from (plan §5).
 *
 * A validator collects errors into a caller-owned array and never throws, so
 * one submission produces the complete list of what is wrong with it. Field
 * lists go through {@link fieldsOf}, which ties them to the body interfaces in
 * `types.ts` at compile time.
 */
import { isBoundedText, isCount, isRecord, isRfc3339, unknownKeys } from './fields.js';

/** Free-text caps. The log carries statements and scopes, not documents. */
export const MAX_SCOPE_LENGTH = 256;
export const MAX_STATEMENT_LENGTH = 4096;
/** A log id identifies an operator's log (a hostname or an opaque token). */
const MAX_LOG_ID_LENGTH = 253;

export type BodyValidator = (body: Record<string, unknown>, errors: string[]) => void;

/**
 * The field list of a body interface, keyed so the compiler checks it in BOTH
 * directions: a field added to, renamed in or removed from `types.ts` breaks
 * this call rather than silently leaving the validator requiring the old name
 * and rejecting the new one as unknown.
 */
export function fieldsOf<TBody>(fields: { [K in keyof Required<TBody>]: true }): readonly string[] {
	return Object.keys(fields);
}

export function requireCount(body: Record<string, unknown>, key: string, errors: string[]): void {
	if (!isCount(body[key])) errors.push(`body.${key} must be a non-negative integer`);
}

export function requireText(
	body: Record<string, unknown>,
	key: string,
	maxLength: number,
	errors: string[]
): void {
	if (!isBoundedText(body[key], maxLength)) {
		errors.push(`body.${key} must be non-blank text of at most ${maxLength} characters`);
	}
}

export function requireRfc3339(body: Record<string, unknown>, key: string, errors: string[]): void {
	if (!isRfc3339(body[key])) errors.push(`body.${key} must be an RFC 3339 timestamp`);
}

/** Reject fields this version does not define: an unknown field is unscored
 *  payload riding inside a signed, permanently published record. */
export function rejectUnknown(
	body: Record<string, unknown>,
	allowed: readonly string[],
	errors: string[]
): void {
	for (const key of unknownKeys(body, allowed)) {
		errors.push(`body.${key} is not a field of this attestation kind`);
	}
}

export function rejectUnknownAt(
	record: Record<string, unknown>,
	allowed: readonly string[],
	path: string,
	errors: string[]
): void {
	for (const key of unknownKeys(record, allowed)) {
		errors.push(`${path}.${key} is not a defined field`);
	}
}

/** Log coordinates: `{ logId, index }` (plan §5, {@link LogEntryRef}). */
export function validateLogEntryRef(value: unknown, path: string, errors: string[]): void {
	if (!isRecord(value)) {
		errors.push(`${path} must be a log entry reference`);
		return;
	}
	rejectUnknownAt(value, ['logId', 'index'], path, errors);
	const logId = value['logId'];
	if (
		typeof logId !== 'string' ||
		logId.length === 0 ||
		logId.length > MAX_LOG_ID_LENGTH ||
		/\s/.test(logId)
	) {
		errors.push(`${path}.logId must be a non-empty identifier without whitespace`);
	}
	if (!isCount(value['index'])) errors.push(`${path}.index must be a non-negative integer`);
}

export function validateLogEntryRefList(value: unknown, path: string, errors: string[]): void {
	if (!Array.isArray(value) || value.length === 0) {
		errors.push(`${path} must be a non-empty array of log entry references`);
		return;
	}
	value.forEach((entry, i) => validateLogEntryRef(entry, `${path}[${i}]`, errors));
}
