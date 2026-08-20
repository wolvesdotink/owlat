/**
 * Deterministic arithmetic for the scoring policy.
 *
 * Every helper here is closed over IEEE-754 operations that ECMAScript
 * specifies exactly (`+ - * /`, comparisons, `Math.round`). `Math.log`,
 * `Math.log10`, `Math.exp` and `Math.pow` are deliberately unused: the spec
 * allows implementation-approximated results, so two engines could disagree in
 * the last bits and break the byte-identical guarantee the policy makes
 * (plan §6.2). The log and half-life scales below are piecewise-linear
 * substitutes: monotone, bounded, and bit-identical everywhere.
 */

const MS_PER_DAY = 86_400_000;

export function clamp(value: number, min: number, max: number): number {
	if (value < min) return min;
	if (value > max) return max;
	return value;
}

/** Round half-up to `decimals` places; `-0` is normalized to `0` for JCS. */
export function roundTo(value: number, decimals: number): number {
	let factor = 1;
	for (let i = 0; i < decimals; i++) factor *= 10;
	const rounded = Math.round(value * factor) / factor;
	return rounded === 0 ? 0 : rounded;
}

/**
 * Position of `value` on a decade scale: `0` at 0, `1` at 10, `2` at 100, with
 * linear interpolation inside each decade. Monotone non-decreasing and a
 * stand-in for `log10` that needs no transcendental function.
 */
export function decadeScale(value: number): number {
	if (!(value > 0)) return 0;
	let decade = 0;
	let magnitude = 1;
	while (magnitude * 10 <= value) {
		magnitude *= 10;
		decade++;
	}
	while (magnitude > value) {
		magnitude /= 10;
		decade--;
	}
	// value / magnitude is in [1, 10) — map it linearly onto [0, 1).
	return decade + (value / magnitude - 1) / 9;
}

/**
 * `value` mapped onto 0..1 against a saturation point on the decade scale.
 * Values at or above `saturation` return 1; non-positive values return 0.
 */
export function logSaturation(value: number, saturation: number): number {
	const ceiling = decadeScale(saturation);
	if (!(ceiling > 0)) return value > 0 ? 1 : 0;
	return clamp(decadeScale(value) / ceiling, 0, 1);
}

/**
 * Fraction of `value` that survives `ageDays` at the given half-life.
 *
 * Exact at whole multiples of the half-life and linearly interpolated in
 * between (so the true 0.707 at half a half-life reads 0.75). The
 * approximation is deliberate: a closed-form exponential would depend on
 * `Math.exp`, whose result is not bit-identical across engines.
 */
export function halfLifeFactor(ageDays: number, halfLifeDays: number): number {
	if (!(ageDays > 0) || !(halfLifeDays > 0)) return 1;
	const periods = ageDays / halfLifeDays;
	const whole = Math.floor(periods);
	// Beyond 64 half-lives the factor is below 2^-64; treat it as gone.
	if (whole >= 64) return 0;
	let factor = 1;
	for (let i = 0; i < whole; i++) factor /= 2;
	return factor * (1 - (periods - whole) / 2);
}

/**
 * RFC 3339 `date-time`, and nothing else.
 *
 * `Date.parse` is not usable here: ECMA-262 defines it only for its own Date
 * Time String Format and leaves every other input implementation-defined, while
 * RFC 3339 — the format `types.ts` mandates for `loggedAt`, `window`, `expires`
 * and `registeredBefore` — admits forms outside that subset (lowercase `t`/`z`,
 * more than three fractional digits). A second implementation of this policy
 * must agree bit for bit, so the grammar is spelled out:
 *
 *     YYYY-MM-DD ("T"|"t") HH:MM:SS ["." 1*DIGIT] ("Z"|"z"|("+"|"-") HH:MM)
 *
 * The RFC's optional space separator is rejected; it is "NOT RECOMMENDED" and
 * never appears in a conforming attestation. Sub-millisecond digits are
 * truncated, not rounded. A leap second (`:60`) is accepted and counted as the
 * 61st second of its minute. Anything else — out-of-range fields, 2020-02-30,
 * a missing offset — is not a timestamp.
 */
const RFC_3339 =
	/^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
	return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/**
 * Days from 1970-01-01 to a proleptic-Gregorian civil date (Hinnant's
 * `days_from_civil`). Integer arithmetic only, so it is exact in IEEE-754 for
 * every year this policy can see.
 */
function daysFromCivil(year: number, month: number, day: number): number {
	const shifted = year - (month <= 2 ? 1 : 0);
	const era = Math.floor(shifted / 400);
	const yearOfEra = shifted - era * 400;
	const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
	const dayOfEra =
		yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
	return era * 146_097 + dayOfEra - 719_468;
}

/** Milliseconds since the epoch, or `undefined` if `value` is not RFC 3339. */
export function parseTimestamp(value: string): number | undefined {
	const match = RFC_3339.exec(value);
	if (match === null) return undefined;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hour = Number(match[4]);
	const minute = Number(match[5]);
	const second = Number(match[6]);
	if (month < 1 || month > 12) return undefined;
	const monthLength =
		(DAYS_IN_MONTH[month - 1] as number) + (month === 2 && isLeapYear(year) ? 1 : 0);
	if (day < 1 || day > monthLength) return undefined;
	// 24:00:00 is not accepted: RFC 3339 allows it only as a same-instant
	// spelling of the next midnight, and two spellings of one instant are a
	// canonicalization hazard.
	if (hour > 23 || minute > 59 || second > 60) return undefined;

	const fraction = match[7] ?? '';
	const millis = fraction === '' ? 0 : Number(`${fraction}000`.slice(0, 3));

	let offsetMinutes = 0;
	const sign = match[8];
	if (sign !== undefined) {
		const offsetHour = Number(match[9]);
		const offsetMinute = Number(match[10]);
		if (offsetHour > 23 || offsetMinute > 59) return undefined;
		offsetMinutes = (offsetHour * 60 + offsetMinute) * (sign === '-' ? -1 : 1);
	}

	const days = daysFromCivil(year, month, day);
	const secondsOfDay = (hour * 60 + minute - offsetMinutes) * 60 + second;
	return (days * 86_400 + secondsOfDay) * 1_000 + millis;
}

/** Whole and fractional days between two instants; a reversed pair reads 0. */
export function daysBetweenMs(fromMs: number, toMs: number): number {
	const delta = (toMs - fromMs) / MS_PER_DAY;
	return delta > 0 ? delta : 0;
}

/**
 * Whole and fractional days from `from` to `to` (both RFC 3339). Returns 0 for
 * unparseable inputs and for `to` before `from`, so a clock skew in a log
 * timestamp can never *increase* the weight of evidence.
 */
export function daysBetween(from: string, to: string): number {
	const fromMs = parseTimestamp(from);
	const toMs = parseTimestamp(to);
	if (fromMs === undefined || toMs === undefined) return 0;
	return daysBetweenMs(fromMs, toMs);
}

/** True when `timestamp` parses and lies at or before `asOf`. */
export function isAtOrBefore(timestamp: string, asOf: string): boolean {
	const at = parseTimestamp(timestamp);
	const bound = parseTimestamp(asOf);
	if (at === undefined || bound === undefined) return false;
	return at <= bound;
}
