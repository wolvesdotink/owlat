/**
 * Minimal iCalendar (RFC 5545) parsing + REPLY building for email invites.
 *
 * Covers the common VEVENT invite shape: SUMMARY/DESCRIPTION/LOCATION, DTSTART/
 * DTEND (UTC `Z`, floating, date-only, and `TZID=` wall-clock), ORGANIZER,
 * ATTENDEE (with PARTSTAT), UID, METHOD. Not a full RFC 5545 implementation —
 * enough to render an invite card and send an RSVP.
 *
 * `ICalDateTime.date` reads floating and TZID values in the runtime's local
 * zone, which is right for a browser rendering an invite card but is UTC on a
 * server. Code that needs the actual instant (e.g. free/busy masking) uses
 * {@link icalDateTimeToEpoch}, which converts from `raw` and does not depend on
 * the host zone.
 */

export interface ICalDateTime {
	raw: string;
	date: Date | null;
	allDay: boolean;
	tzid?: string;
}

export interface ICalAttendee {
	name?: string;
	email?: string;
	partstat?: string;
}

export interface ICalEvent {
	uid?: string;
	summary?: string;
	description?: string;
	location?: string;
	start?: ICalDateTime;
	end?: ICalDateTime;
	organizer?: { name?: string; email?: string };
	attendees: ICalAttendee[];
	sequence?: number;
}

export interface ICalParsed {
	method?: string;
	events: ICalEvent[];
}

/** Unfold RFC 5545 continuation lines (folded with CRLF + space/tab). */
function unfold(text: string): string[] {
	return text
		.replace(/\r\n/g, '\n')
		.replace(/\n[ \t]/g, '')
		.split('\n');
}

interface ContentLine {
	name: string;
	params: Record<string, string>;
	value: string;
}

function parseLine(line: string): ContentLine | null {
	const colon = line.indexOf(':');
	if (colon < 0) return null;
	const left = line.slice(0, colon);
	const value = line.slice(colon + 1);
	const segments = left.split(';');
	const name = (segments[0] ?? '').toUpperCase();
	const params: Record<string, string> = {};
	for (let i = 1; i < segments.length; i++) {
		const eq = segments[i]!.indexOf('=');
		if (eq < 0) continue;
		params[segments[i]!.slice(0, eq).toUpperCase()] = segments[i]!.slice(eq + 1).replace(
			/^"|"$/g,
			''
		);
	}
	return { name, params, value };
}

function unescapeText(v: string): string {
	return v.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

function parseDateTime(line: ContentLine): ICalDateTime {
	const v = line.value.trim();
	const tzid = line.params['TZID'];
	const allDay = line.params['VALUE'] === 'DATE' || /^\d{8}$/.test(v);
	let date: Date | null = null;
	const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
	if (m) {
		const [, y, mo, d, hh, mm, ss, z] = m;
		const Y = Number(y),
			Mo = Number(mo) - 1,
			D = Number(d);
		const H = Number(hh ?? '0'),
			Mi = Number(mm ?? '0'),
			S = Number(ss ?? '0');
		// `Z` → UTC; floating / TZID → treat as the viewer's local wall-clock
		// (we don't ship a tz database). All-day → local midnight.
		date = z ? new Date(Date.UTC(Y, Mo, D, H, Mi, S)) : new Date(Y, Mo, D, H, Mi, S);
	}
	return { raw: v, date, allDay, tzid };
}

/** Wall-clock fields of an instant, read in a given IANA timezone. Throws a
 * RangeError when `timeZone` is not a zone the runtime knows. */
export function getTzParts(
	ms: number,
	timeZone: string
): {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
	weekday: number;
} {
	const dtf = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		weekday: 'short',
	});
	const parts = dtf.formatToParts(new Date(ms));
	const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
	const weekdayMap: Record<string, number> = {
		Sun: 0,
		Mon: 1,
		Tue: 2,
		Wed: 3,
		Thu: 4,
		Fri: 5,
		Sat: 6,
	};
	return {
		year: Number(get('year')),
		month: Number(get('month')),
		day: Number(get('day')),
		hour: Number(get('hour')),
		minute: Number(get('minute')),
		second: Number(get('second')),
		weekday: weekdayMap[get('weekday')] ?? 0,
	};
}

/** The zone's UTC offset (ms, east positive) at the given instant. */
function zoneOffsetAt(ms: number, timeZone: string): number {
	const whole = Math.floor(ms / 1000) * 1000;
	const p = getTzParts(whole, timeZone);
	return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - whole;
}

/**
 * Epoch-ms for a wall-clock Y/M/D H:M:S (month 1-based) in the given IANA
 * timezone. The offset is read at the naive instant and then re-read at the
 * corrected one, so a time just past a DST switch lands on the right side. A
 * wall-clock time skipped by a spring-forward gap resolves to an instant an
 * hour off, which is fine for busy masking and slot proposals. Throws a
 * RangeError for an unknown zone.
 */
export function wallClockToEpoch(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	timeZone: string,
	second = 0
): number {
	const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
	const firstOffset = zoneOffsetAt(asUtc, timeZone);
	const secondOffset = zoneOffsetAt(asUtc - firstOffset, timeZone);
	return asUtc - secondOffset;
}

const ICAL_DATE_TIME_RE = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/;

/**
 * The instant an iCalendar DATE or DATE-TIME value stands for, as epoch ms,
 * parsed from `dt.raw`:
 * - a `Z` value is UTC;
 * - a `TZID=` value is a wall clock in that IANA zone; an unknown zone name
 *   (Windows names, vendor prefixes) falls back to `fallbackTz`;
 * - floating values and all-day (`VALUE=DATE`) values are read in `fallbackTz`
 *   (all-day values at local midnight).
 * Returns null for a value that is not a date, or when no usable zone is left.
 */
export function icalDateTimeToEpoch(dt: ICalDateTime, fallbackTz: string): number | null {
	const m = ICAL_DATE_TIME_RE.exec(dt.raw.trim());
	if (!m) return null;
	const [, y, mo, d, hh, mi, ss, z] = m;
	const year = Number(y);
	const month = Number(mo);
	const day = Number(d);
	const hour = Number(hh ?? '0');
	const minute = Number(mi ?? '0');
	const second = Number(ss ?? '0');
	// Reject calendar overflow (month 13, Feb 30) instead of letting Date.UTC roll it over.
	const calendarDay = new Date(Date.UTC(year, month - 1, day));
	if (calendarDay.getUTCMonth() !== month - 1 || calendarDay.getUTCDate() !== day) return null;
	if (hour > 23 || minute > 59 || second > 60) return null;
	if (z) return Date.UTC(year, month - 1, day, hour, minute, second);
	const zones = !dt.allDay && hh !== undefined && dt.tzid ? [dt.tzid, fallbackTz] : [fallbackTz];
	for (const zone of zones) {
		try {
			return wallClockToEpoch(year, month, day, hour, minute, zone, second);
		} catch (err) {
			if (!(err instanceof RangeError)) throw err;
		}
	}
	return null;
}

function parseCalAddress(line: ContentLine): { name?: string; email?: string; partstat?: string } {
	const email = line.value.replace(/^mailto:/i, '').trim() || undefined;
	return {
		name: line.params['CN'],
		email,
		partstat: line.params['PARTSTAT'],
	};
}

export function parseICalendar(text: string): ICalParsed {
	const lines = unfold(text);
	const result: ICalParsed = { events: [] };
	let event: ICalEvent | null = null;
	for (const raw of lines) {
		const line = parseLine(raw);
		if (!line) continue;
		if (line.name === 'METHOD') {
			result.method = line.value.trim().toUpperCase();
			continue;
		}
		if (line.name === 'BEGIN' && line.value.trim().toUpperCase() === 'VEVENT') {
			event = { attendees: [] };
			continue;
		}
		if (line.name === 'END' && line.value.trim().toUpperCase() === 'VEVENT') {
			if (event) result.events.push(event);
			event = null;
			continue;
		}
		if (!event) continue;
		switch (line.name) {
			case 'UID':
				event.uid = line.value.trim();
				break;
			case 'SUMMARY':
				event.summary = unescapeText(line.value);
				break;
			case 'DESCRIPTION':
				event.description = unescapeText(line.value);
				break;
			case 'LOCATION':
				event.location = unescapeText(line.value);
				break;
			case 'DTSTART':
				event.start = parseDateTime(line);
				break;
			case 'DTEND':
				event.end = parseDateTime(line);
				break;
			case 'SEQUENCE':
				event.sequence = Number(line.value.trim()) || 0;
				break;
			case 'ORGANIZER': {
				const a = parseCalAddress(line);
				event.organizer = { name: a.name, email: a.email };
				break;
			}
			case 'ATTENDEE':
				event.attendees.push(parseCalAddress(line));
				break;
			default:
				break;
		}
	}
	return result;
}

function fmtUtc(d: Date): string {
	const p = (n: number) => String(n).padStart(2, '0');
	return (
		`${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
		`T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
	);
}

/** Escape a TEXT property value per RFC 5545 §3.3.11 (\, ;, ,, newlines). */
function escapeText(value: string): string {
	return value
		.replace(/\\/g, '\\\\')
		.replace(/;/g, '\\;')
		.replace(/,/g, '\\,')
		.replace(/\r?\n/g, '\\n');
}

/** Strip CR/LF so an address can't smuggle in extra content lines. */
function sanitizeAddress(value: string): string {
	return value.replace(/[\r\n]/g, '').trim();
}

export type Partstat = 'ACCEPTED' | 'DECLINED' | 'TENTATIVE';

/**
 * Build a METHOD:REPLY VCALENDAR for an RSVP. `nowUtc` is injected so callers
 * stamp DTSTAMP (this module is environment-pure).
 */
export function buildReplyICalendar(
	event: ICalEvent,
	attendeeEmail: string,
	partstat: Partstat,
	nowUtc: Date
): string {
	const lines = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//Owlat//Postbox//EN',
		'METHOD:REPLY',
		'BEGIN:VEVENT',
		`UID:${escapeText(event.uid ?? '')}`,
		`DTSTAMP:${fmtUtc(nowUtc)}`,
		`SEQUENCE:${event.sequence ?? 0}`,
		event.organizer?.email ? `ORGANIZER:mailto:${sanitizeAddress(event.organizer.email)}` : '',
		`ATTENDEE;PARTSTAT=${partstat}:mailto:${sanitizeAddress(attendeeEmail)}`,
		event.summary ? `SUMMARY:${escapeText(event.summary)}` : '',
		'END:VEVENT',
		'END:VCALENDAR',
	].filter(Boolean);
	return `${lines.join('\r\n')}\r\n`;
}
