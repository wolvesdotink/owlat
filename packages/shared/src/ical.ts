/**
 * Minimal iCalendar (RFC 5545) parsing + REPLY building for email invites.
 *
 * Covers the common VEVENT invite shape: SUMMARY/DESCRIPTION/LOCATION, DTSTART/
 * DTEND (UTC `Z`, floating, date-only, and `TZID=` wall-clock), ORGANIZER,
 * ATTENDEE (with PARTSTAT), UID, METHOD. Not a full RFC 5545 implementation —
 * enough to render an invite card and send an RSVP.
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
	return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
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
		params[segments[i]!.slice(0, eq).toUpperCase()] = segments[i]!.slice(eq + 1).replace(/^"|"$/g, '');
	}
	return { name, params, value };
}

function unescapeText(v: string): string {
	return v
		.replace(/\\n/gi, '\n')
		.replace(/\\,/g, ',')
		.replace(/\\;/g, ';')
		.replace(/\\\\/g, '\\');
}

function parseDateTime(line: ContentLine): ICalDateTime {
	const v = line.value.trim();
	const tzid = line.params['TZID'];
	const allDay = line.params['VALUE'] === 'DATE' || /^\d{8}$/.test(v);
	let date: Date | null = null;
	const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
	if (m) {
		const [, y, mo, d, hh, mm, ss, z] = m;
		const Y = Number(y), Mo = Number(mo) - 1, D = Number(d);
		const H = Number(hh ?? '0'), Mi = Number(mm ?? '0'), S = Number(ss ?? '0');
		// `Z` → UTC; floating / TZID → treat as the viewer's local wall-clock
		// (we don't ship a tz database). All-day → local midnight.
		date = z ? new Date(Date.UTC(Y, Mo, D, H, Mi, S)) : new Date(Y, Mo, D, H, Mi, S);
	}
	return { raw: v, date, allDay, tzid };
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
