/**
 * Microsoft SNDS data-feed parsing.
 *
 * PURE: feed text in, typed observations out. No clock, no database, no env —
 * every bound and every verdict is a parameter or a constant here, which is
 * what makes the hostile-input tests exhaustive.
 *
 * The feed is a headerless CSV, one row per (IP, activity window). Microsoft
 * publishes activity in sub-day blocks, so a UTC day is several rows that we
 * fold together in {@link aggregateSndsDays}.
 *
 * The single most important modelling decision: SNDS reports a complaint-rate
 * BAND, not a rate. We keep the band as a small enumerated type all the way to
 * the gate. Converting `0.1% - < 0.2%` to `0.0015` would invent a precision the
 * feed does not have, and every consumer downstream would then be reasoning
 * about a number Microsoft never published.
 */

/**
 * Complaint-rate bands, ordered. `unknown` is first and is NOT a severity: it
 * is the honest outcome for a day Microsoft withheld the band (too little
 * volume) or reported it in a spelling this parser does not recognise.
 */
export const SNDS_COMPLAINT_BANDS = [
	'unknown',
	'lt_0_1',
	'0_1_to_0_2',
	'0_2_to_0_3',
	'0_3_to_0_4',
	'0_4_to_0_5',
	'0_5_to_0_6',
	'0_6_to_0_7',
	'0_7_to_0_8',
	'0_8_to_0_9',
	'gte_0_9',
] as const;

export type SndsComplaintBand = (typeof SNDS_COMPLAINT_BANDS)[number];

/** The banded values in ascending severity, without the `unknown` sentinel. */
const BAND_SEVERITY_ORDER: readonly SndsComplaintBand[] = SNDS_COMPLAINT_BANDS.slice(1);

/**
 * Rank a band for comparison. `null` for `unknown` — deliberately not `0`, so a
 * caller cannot accidentally treat "no data" as "the cleanest band".
 */
export function complaintBandSeverity(band: SndsComplaintBand): number | null {
	const index = BAND_SEVERITY_ORDER.indexOf(band);
	return index === -1 ? null : index;
}

/** The worse of two bands; `unknown` loses to anything banded. */
export function worseComplaintBand(a: SndsComplaintBand, b: SndsComplaintBand): SndsComplaintBand {
	const severityA = complaintBandSeverity(a);
	const severityB = complaintBandSeverity(b);
	if (severityA === null) return b;
	if (severityB === null) return a;
	return severityB > severityA ? b : a;
}

/** SNDS "Filter result" — the traffic-light verdict on the IP's mail. */
export const SNDS_FILTER_RESULTS = ['unknown', 'green', 'yellow', 'red'] as const;
export type SndsFilterResult = (typeof SNDS_FILTER_RESULTS)[number];

const FILTER_SEVERITY: Record<SndsFilterResult, number> = {
	unknown: -1,
	green: 0,
	yellow: 1,
	red: 2,
};

export function worseFilterResult(a: SndsFilterResult, b: SndsFilterResult): SndsFilterResult {
	return FILTER_SEVERITY[b] > FILTER_SEVERITY[a] ? b : a;
}

/** One parsed feed row: an IP's activity over one sub-day window. */
export interface SndsFeedRow {
	ip: string;
	activityStart: number;
	activityEnd: number;
	filterResult: SndsFilterResult;
	complaintBand: SndsComplaintBand;
	rcptCommands?: number;
	dataCommands?: number;
	messageRecipients?: number;
	trapHits?: number;
	sampleHelo?: string;
}

/** One IP's folded activity for one UTC day — what we persist and gate on. */
export interface SndsDayObservation {
	ip: string;
	periodStart: number;
	filterResult: SndsFilterResult;
	complaintBand: SndsComplaintBand;
	trapHits: number;
	messageRecipients: number;
	rcptCommands: number;
	dataCommands: number;
	sampleHelo?: string;
}

export interface SndsParseResult {
	rows: SndsFeedRow[];
	/** Rows the parser refused. Counted, never thrown — the feed is internet input. */
	dropped: number;
	/** Whether the row cap cut the feed short. */
	truncated: boolean;
}

/** Hard bounds. A feed is externally supplied, so every dimension is capped. */
export const SNDS_MAX_FEED_BYTES = 4 * 1024 * 1024;
export const SNDS_MAX_ROWS = 20_000;
const MAX_LINE_LENGTH = 2_048;
const MAX_COUNTER = 1_000_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_RE = /^[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}$/;
const HELO_RE = /^[a-z0-9](?:[a-z0-9._-]{0,251}[a-z0-9])?$/;

/**
 * Canonicalize a feed IP. Returns `null` for anything that is not plainly an
 * address — the IP is a stored key and an allowlist input, so a lax parse here
 * would let a malformed row create junk keys forever.
 */
export function normalizeSndsIp(raw: string): string | null {
	const value = raw.trim().toLowerCase();
	if (value.length === 0 || value.length > 45) return null;
	const ipv4 = value.match(IPV4_RE);
	if (ipv4) {
		const octets = ipv4.slice(1).map((part) => Number(part));
		if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
		// Reject `01.2.3.4` style padding so one address has exactly one key.
		return ipv4.slice(1).some((part) => part.length > 1 && part.startsWith('0'))
			? null
			: octets.join('.');
	}
	return IPV6_RE.test(value) ? value : null;
}

const TIMESTAMP_RE =
	/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AaPp])\.?[Mm]\.?)?$/;

/**
 * Parse an SNDS `M/D/YYYY h:mm[:ss] AM` timestamp as UTC.
 *
 * Returns `null` rather than `NaN` or a wrapped date: `2/31/2026` must be a
 * dropped row, not silently March 3rd.
 */
export function parseSndsTimestamp(raw: string): number | null {
	const match = raw.trim().match(TIMESTAMP_RE);
	if (!match) return null;
	const [, monthText, dayText, yearText, hourText, minuteText, secondText, meridiem] = match;
	if (
		monthText === undefined ||
		dayText === undefined ||
		yearText === undefined ||
		hourText === undefined ||
		minuteText === undefined
	) {
		return null;
	}
	const month = Number(monthText);
	const day = Number(dayText);
	const year = Number(yearText);
	let hour = Number(hourText);
	const minute = Number(minuteText);
	const second = secondText === undefined ? 0 : Number(secondText);
	if (meridiem !== undefined) {
		const isPm = meridiem.toLowerCase() === 'p';
		if (hour < 1 || hour > 12) return null;
		hour = (hour % 12) + (isPm ? 12 : 0);
	}
	if (
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > 31 ||
		year < 2000 ||
		year > 2999 ||
		hour > 23 ||
		minute > 59 ||
		second > 59
	) {
		return null;
	}
	const timestamp = Date.UTC(year, month - 1, day, hour, minute, second);
	const parsed = new Date(timestamp);
	// Round-trip guard: rejects 2/31 and friends instead of rolling them over.
	return parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day ? timestamp : null;
}

/**
 * Map the feed's complaint-rate text to a band.
 *
 * FORWARD-COMPATIBLE BY CONSTRUCTION: a spelling this parser has never seen —
 * a new band, a localized separator, an empty cell — becomes `unknown`. It
 * never throws and never guesses a neighbouring band, because a wrong band is
 * worse than no band: `unknown` holds the ramp, a fabricated band moves it.
 */
export function parseComplaintBand(raw: string): SndsComplaintBand {
	const text = raw.trim();
	if (text.length === 0) return 'unknown';
	if (text.startsWith('<')) return 'lt_0_1';
	if (text.startsWith('>')) return 'gte_0_9';
	const first = text.match(/\d+(?:\.\d+)?/)?.[0];
	if (first === undefined) return 'unknown';
	const lowerBound = Number(first);
	if (!Number.isFinite(lowerBound) || lowerBound < 0) return 'unknown';
	// Floor, not round: `0.05%` belongs in the band BELOW 0.1%, and the epsilon
	// keeps binary floating point from turning 0.3 * 10 into 2.999….
	const tenths = Math.floor(lowerBound * 10 + 1e-9);
	if (tenths < 1) return 'lt_0_1';
	if (tenths >= 9) return 'gte_0_9';
	return SNDS_COMPLAINT_BANDS[tenths + 1] ?? 'unknown';
}

export function parseFilterResult(raw: string): SndsFilterResult {
	const value = raw.trim().toLowerCase();
	return value === 'green' || value === 'yellow' || value === 'red' ? value : 'unknown';
}

/** A non-negative bounded integer, or `undefined` for anything else. */
function parseCounter(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const value = raw.trim();
	if (!/^\d{1,15}$/.test(value)) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed <= MAX_COUNTER ? parsed : undefined;
}

function parseHelo(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	const value = raw.trim().toLowerCase();
	return HELO_RE.test(value) ? value : undefined;
}

/**
 * SNDS column order (headerless CSV):
 * `IP, activity start, activity end, RCPT, DATA, recipients, filter result,
 *  complaint rate, trap period, trap hits, sample HELO, sample MAIL FROM, …`
 *
 * A row is USABLE from the complaint-rate column leftwards; everything after it
 * is optional, so a truncated tail is a partial row we keep, not a drop.
 */
const MIN_FIELDS = 8;

function parseRow(line: string): SndsFeedRow | null {
	const fields = line.split(',').map((field) => field.trim());
	if (fields.length < MIN_FIELDS) return null;
	const ip = normalizeSndsIp(fields[0] ?? '');
	const activityStart = parseSndsTimestamp(fields[1] ?? '');
	const activityEnd = parseSndsTimestamp(fields[2] ?? '');
	if (ip === null || activityStart === null || activityEnd === null) return null;
	if (activityEnd < activityStart) return null;
	const rcptCommands = parseCounter(fields[3]);
	const dataCommands = parseCounter(fields[4]);
	const messageRecipients = parseCounter(fields[5]);
	const trapHits = parseCounter(fields[9]);
	const sampleHelo = parseHelo(fields[10]);
	return {
		ip,
		activityStart,
		activityEnd,
		filterResult: parseFilterResult(fields[6] ?? ''),
		complaintBand: parseComplaintBand(fields[7] ?? ''),
		...(rcptCommands !== undefined ? { rcptCommands } : {}),
		...(dataCommands !== undefined ? { dataCommands } : {}),
		...(messageRecipients !== undefined ? { messageRecipients } : {}),
		...(trapHits !== undefined ? { trapHits } : {}),
		...(sampleHelo !== undefined ? { sampleHelo } : {}),
	};
}

/**
 * Parse a whole feed body. Never throws: a malformed row is dropped and
 * counted, an oversized body is cut at the row cap and flagged `truncated`.
 */
export function parseSndsFeed(body: string, maxRows: number = SNDS_MAX_ROWS): SndsParseResult {
	const rows: SndsFeedRow[] = [];
	let dropped = 0;
	let truncated = false;
	for (const rawLine of body.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line.length === 0) continue;
		if (rows.length >= maxRows) {
			truncated = true;
			break;
		}
		if (line.length > MAX_LINE_LENGTH) {
			dropped += 1;
			continue;
		}
		const row = parseRow(line);
		if (row === null) dropped += 1;
		else rows.push(row);
	}
	return { rows, dropped, truncated };
}

export function utcDayStart(timestamp: number): number {
	return Math.floor(timestamp / DAY_MS) * DAY_MS;
}

/**
 * Fold sub-day rows into one observation per (IP, UTC day).
 *
 * Counters SUM; the band and the filter result take the WORST value seen that
 * day. Worst-not-latest is deliberate: the day is a gate input, and a bad
 * eight-hour block followed by a quiet one is still a bad day.
 */
export function aggregateSndsDays(rows: readonly SndsFeedRow[]): SndsDayObservation[] {
	const byCell = new Map<string, SndsDayObservation>();
	for (const row of rows) {
		const periodStart = utcDayStart(row.activityStart);
		const key = `${row.ip} ${periodStart}`;
		const existing = byCell.get(key);
		if (existing === undefined) {
			byCell.set(key, {
				ip: row.ip,
				periodStart,
				filterResult: row.filterResult,
				complaintBand: row.complaintBand,
				trapHits: row.trapHits ?? 0,
				messageRecipients: row.messageRecipients ?? 0,
				rcptCommands: row.rcptCommands ?? 0,
				dataCommands: row.dataCommands ?? 0,
				...(row.sampleHelo !== undefined ? { sampleHelo: row.sampleHelo } : {}),
			});
			continue;
		}
		existing.filterResult = worseFilterResult(existing.filterResult, row.filterResult);
		existing.complaintBand = worseComplaintBand(existing.complaintBand, row.complaintBand);
		existing.trapHits += row.trapHits ?? 0;
		existing.messageRecipients += row.messageRecipients ?? 0;
		existing.rcptCommands += row.rcptCommands ?? 0;
		existing.dataCommands += row.dataCommands ?? 0;
		if (existing.sampleHelo === undefined && row.sampleHelo !== undefined) {
			existing.sampleHelo = row.sampleHelo;
		}
	}
	return [...byCell.values()].sort(
		(a, b) => a.ip.localeCompare(b.ip) || a.periodStart - b.periodStart
	);
}
