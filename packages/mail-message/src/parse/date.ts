/**
 * RFC 5322 §3.3 (with §4.3 obsolete forms) `Date:` header parsing.
 *
 * Supports the obsolete named time zones (`UT`, `GMT`, `EST`…`PDT`, and the
 * military single-letter zones), 2- and 3-digit years, and an optional leading
 * day-of-week. Anything that is not a well-formed, in-range date returns
 * `undefined` (never an `Invalid Date`), so callers can treat a missing/broken
 * `Date:` uniformly.
 */

const MONTHS: Record<string, number> = {
	jan: 0,
	feb: 1,
	mar: 2,
	apr: 3,
	may: 4,
	jun: 5,
	jul: 6,
	aug: 7,
	sep: 8,
	oct: 9,
	nov: 10,
	dec: 11,
};

/** Obsolete named zones → offset in minutes east of UTC. */
const NAMED_ZONES: Record<string, number> = {
	ut: 0,
	gmt: 0,
	utc: 0,
	z: 0,
	est: -300,
	edt: -240,
	cst: -360,
	cdt: -300,
	mst: -420,
	mdt: -360,
	pst: -480,
	pdt: -420,
};

/**
 * Expand a 2- or 3-digit year per RFC 5322 §4.3: 0–49 → 2000–2049, 50–99 →
 * 1950–1999, 3-digit `n` → `1900 + n`. 4-digit years pass through.
 */
function expandYear(raw: string): number {
	const n = Number.parseInt(raw, 10);
	if (raw.length <= 2) return n < 50 ? 2000 + n : 1900 + n;
	if (raw.length === 3) return 1900 + n;
	return n;
}

/** Resolve a zone token to an offset in minutes east of UTC, or `undefined`. */
function zoneOffsetMinutes(token: string | undefined): number | undefined {
	if (token === undefined || token === '') return 0;
	const numeric = token.match(/^([+-])(\d{2})(\d{2})$/);
	if (numeric) {
		const sign = numeric[1] === '-' ? -1 : 1;
		const hh = Number.parseInt(numeric[2]!, 10);
		const mm = Number.parseInt(numeric[3]!, 10);
		if (hh > 23 || mm > 59) return undefined;
		return sign * (hh * 60 + mm);
	}
	const named = token.toLowerCase();
	if (named in NAMED_ZONES) return NAMED_ZONES[named];
	// A single-letter military zone other than `Z` has an indeterminate offset
	// per §4.3 and is conventionally treated as UTC (-0000).
	if (/^[a-y]$/i.test(token)) return 0;
	return undefined;
}

/**
 * Parse an RFC 5322 `Date:` header value into a {@link Date}, or `undefined`
 * when the value is not a valid date.
 */
export function parseDate(value: string | undefined): Date | undefined {
	if (value === undefined) return undefined;
	// Drop a leading `Dow,` and collapse whitespace; comments are rare in the
	// wild and not supported.
	const cleaned = value
		.replace(/^[ \t]*[A-Za-z]{3,9}[ \t]*,[ \t]*/, '')
		.trim()
		.replace(/[ \t]+/g, ' ');
	const m = cleaned.match(
		/^(\d{1,2}) ([A-Za-z]{3}) (\d{2,4}) (\d{1,2}):(\d{2})(?::(\d{2}))?(?: ([+-]\d{4}|[A-Za-z]+))?$/
	);
	if (!m) return undefined;

	const day = Number.parseInt(m[1]!, 10);
	const monthIdx = MONTHS[m[2]!.toLowerCase()];
	if (monthIdx === undefined) return undefined;
	const year = expandYear(m[3]!);
	const hour = Number.parseInt(m[4]!, 10);
	const minute = Number.parseInt(m[5]!, 10);
	const second = m[6] === undefined ? 0 : Number.parseInt(m[6], 10);

	if (day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) return undefined;

	const offset = zoneOffsetMinutes(m[7]);
	if (offset === undefined) return undefined;

	const base = Date.UTC(year, monthIdx, day, hour, minute, second);
	const check = new Date(base);
	// Reject impossible calendar dates (e.g. 31 Feb) that Date.UTC rolls over.
	if (
		check.getUTCFullYear() !== year ||
		check.getUTCMonth() !== monthIdx ||
		check.getUTCDate() !== day
	) {
		return undefined;
	}
	return new Date(base - offset * 60000);
}
