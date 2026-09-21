/**
 * Field-level predicates shared by envelope, body and key-record validation.
 *
 * Every predicate is total — it answers for arbitrary `unknown` and never
 * throws — and checks values in the exact form they were signed in rather than
 * normalizing them. Canonical JSON is signed byte-for-byte, so `Example.com`
 * and `example.com` are two different subjects with two different signatures:
 * accepting both spellings would split one sender's history in half.
 */

/** A JSON object — arrays and `null` are not attestation records. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Non-negative safe integer: every count, bucket exponent and log index. */
export function isCount(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Own keys of `record` that are not in `allowed`, sorted for stable errors. */
export function unknownKeys(record: Record<string, unknown>, allowed: readonly string[]): string[] {
	return Object.keys(record)
		.filter((key) => !allowed.includes(key))
		.sort();
}

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** All-numeric TLDs do not exist; requiring a leading letter keeps a dotted
 *  quad from validating as a domain name. */
const DNS_TLD = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])$/;

/**
 * Lowercase FQDN in presentation form: at least two labels, no trailing dot,
 * at most 253 characters. Uppercase is rejected, not folded (see file header).
 */
export function isFqdn(value: unknown): value is string {
	if (typeof value !== 'string' || value.length === 0 || value.length > 253) return false;
	const labels = value.split('.');
	if (labels.length < 2) return false;
	const tld = labels[labels.length - 1];
	if (tld === undefined || !DNS_TLD.test(tld)) return false;
	return labels.every((label) => DNS_LABEL.test(label));
}

// Address literals carry their own canonicalization rules and live next door.
export { isIpAddress, isIpv4, isIpv6 } from './ipAddress.js';

/**
 * One instant, one spelling: uppercase `T`, UTC `Z`, at most milliseconds.
 *
 * RFC 3339 admits `2026-08-19T00:00:00Z`, `2026-08-19t00:00:00z` and
 * `2026-08-19T02:00:00+02:00` for one moment. All three would be byte-distinct
 * subjects of one signature, and consumers that compare window bounds as
 * strings would order them wrongly, so only the first form is accepted.
 * Callers holding a timestamp in another form normalize before signing.
 */
const RFC3339_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/;

function daysInMonth(year: number, month: number): number {
	if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
	return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/**
 * RFC 3339 UTC date-time, checked component by component: `Date.parse`
 * silently rolls `2026-02-30` over into March, which would let two spellings of
 * one instant into the log. Leap seconds (`:60`) are rejected — they have no
 * `Date` representation to order windows by. Numeric offsets, lowercase
 * designators and sub-millisecond precision are rejected, not normalized.
 */
export function isRfc3339(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	const match = RFC3339_UTC.exec(value);
	if (match === null) return false;
	// The regex guarantees six digit groups; a missing one would read NaN here
	// and fail every comparison below.
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return false;
	return Number(match[4]) <= 23 && Number(match[5]) <= 59 && Number(match[6]) <= 59;
}

/**
 * Order two RFC 3339 instants. Lexical comparison agrees with this for equal
 * fractional precision and disagrees across it (`…:00.500Z` sorts before
 * `…:00Z`), so consumers that sort or take minima go through here.
 * Non-timestamps sort after every timestamp rather than throwing.
 */
export function compareRfc3339(a: unknown, b: unknown): number {
	if (!isRfc3339(a)) return isRfc3339(b) ? 1 : 0;
	if (!isRfc3339(b)) return -1;
	return Math.sign(Date.parse(a) - Date.parse(b));
}

/**
 * `from <= to` for two RFC 3339 instants. Returns false if either side is not
 * a valid timestamp.
 */
export function isChronological(from: unknown, to: unknown): boolean {
	if (!isRfc3339(from) || !isRfc3339(to)) return false;
	return Date.parse(from) <= Date.parse(to);
}

/** Lowercase hex sha256 digest, as commitments and key hashes are published. */
export function isSha256Hex(value: unknown): value is string {
	return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Canonical standard-alphabet base64: correct padding, no whitespace, and no
 * non-zero bits past the declared length — `Buffer.from` silently accepts all
 * three, which would let one key have several spellings.
 */
export function isBase64(value: unknown): value is string {
	if (typeof value !== 'string' || value.length === 0) return false;
	if (value.length % 4 !== 0 || !BASE64.test(value)) return false;
	return Buffer.from(value, 'base64').toString('base64') === value;
}

/** Canonical base64 decoding to exactly `bytes` octets. */
export function isBase64OfLength(value: unknown, bytes: number): value is string {
	return isBase64(value) && Buffer.from(value, 'base64').length === bytes;
}

/** Raw 32-byte ed25519 key material, base64 — the form `crypto.ts` takes. */
export function isEd25519Key(value: unknown): value is string {
	return isBase64OfLength(value, 32);
}

const DKIM_SELECTOR = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** DKIM selector: dot-separated sub-domains (RFC 6376 §3.1), case preserved. */
export function isDkimSelector(value: unknown): value is string {
	if (typeof value !== 'string' || value.length === 0 || value.length > 253) return false;
	return value.split('.').every((label) => DKIM_SELECTOR.test(label));
}

/** Tab and newline are the only control characters a statement may carry. */
function hasForbiddenControlChar(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code === 0x09 || code === 0x0a) continue;
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

/**
 * Human-readable free text in a body: non-blank, length-capped, and free of
 * control characters other than tab and newline. The caps are admissibility
 * limits — the log stores statements, not documents.
 */
export function isBoundedText(value: unknown, maxLength: number): value is string {
	if (typeof value !== 'string' || value.trim().length === 0) return false;
	return value.length <= maxLength && !hasForbiddenControlChar(value);
}
