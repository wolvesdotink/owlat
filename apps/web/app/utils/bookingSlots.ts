/**
 * Pure helpers for showing booking slots: the server hands out instants (epoch
 * ms) and these lay them out in the viewer's time zone — grouped by local day,
 * on a Monday-first month grid, as times of day. Also the composer's "Insert
 * availability" block. No Vue, no Nuxt: unit-tested on its own.
 */
import { escapeHtml } from '@owlat/shared/html';
import { getTzParts, wallClockToEpoch } from '@owlat/shared/ical';

/** `YYYY-MM-DD` of an instant in a zone. */
export function zonedDateKey(ms: number, timeZone: string): string {
	const p = getTzParts(ms, timeZone);
	return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Slots grouped by their local date in `timeZone`, each list ascending. */
export function groupSlotsByDay(slots: readonly number[], timeZone: string): Map<string, number[]> {
	const days = new Map<string, number[]>();
	for (const slot of [...slots].sort((a, b) => a - b)) {
		const key = zonedDateKey(slot, timeZone);
		const list = days.get(key);
		if (list) list.push(slot);
		else days.set(key, [slot]);
	}
	return days;
}

/** The instants a month spans in `timeZone`: `[first midnight, next month's midnight)`. */
export function monthWindow(
	year: number,
	month: number,
	timeZone: string
): { from: number; until: number } {
	const next = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
	return {
		from: wallClockToEpoch(year, month, 1, 0, 0, timeZone),
		until: wallClockToEpoch(next.year, next.month, 1, 0, 0, timeZone),
	};
}

export interface CalendarCell {
	key: string;
	day: number;
	inMonth: boolean;
}

/** A Monday-first grid of whole weeks covering `month` (1-based). */
export function calendarWeeks(year: number, month: number): CalendarCell[][] {
	const first = new Date(Date.UTC(year, month - 1, 1));
	const lead = (first.getUTCDay() + 6) % 7;
	const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
	const cells = Math.ceil((lead + daysInMonth) / 7) * 7;
	const weeks: CalendarCell[][] = [];
	for (let i = 0; i < cells; i++) {
		const date = new Date(Date.UTC(year, month - 1, 1 - lead + i));
		const cell = {
			key: `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`,
			day: date.getUTCDate(),
			inMonth: date.getUTCMonth() === month - 1,
		};
		if (i % 7 === 0) weeks.push([]);
		weeks[weeks.length - 1]!.push(cell);
	}
	return weeks;
}

/** The viewer's zone, or UTC when the runtime cannot say. */
export function browserTimeZone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
	} catch {
		return 'UTC';
	}
}

/** Every zone the runtime knows, with `current` first-class even when it is not listed. */
export function timeZoneOptions(current: string): string[] {
	let zones: string[] = [];
	try {
		zones =
			(Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ??
			[];
	} catch {
		zones = [];
	}
	const all = new Set(zones.length > 0 ? zones : ['UTC']);
	all.add(current);
	return [...all].sort();
}

/** "10:30" / "10:30 AM", in the viewer's locale and zone. */
export function formatSlotTime(ms: number, locale: string, timeZone: string): string {
	return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone }).format(
		ms
	);
}

/** "Tuesday, March 3" for a `YYYY-MM-DD` key. */
export function formatDayKey(key: string, locale: string): string {
	const [y, m, d] = key.split('-').map(Number);
	return new Intl.DateTimeFormat(locale, {
		weekday: 'long',
		month: 'long',
		day: 'numeric',
		timeZone: 'UTC',
	}).format(Date.UTC(y!, m! - 1, d!));
}

/** "Tue, Mar 3, 10:30 – 11:00", in the viewer's locale and zone. */
export function formatSlotRange(
	start: number,
	end: number,
	locale: string,
	timeZone: string
): string {
	const day = new Intl.DateTimeFormat(locale, {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		timeZone,
	}).format(start);
	return `${day}, ${formatSlotTime(start, locale, timeZone)} – ${formatSlotTime(end, locale, timeZone)}`;
}

export interface AvailabilitySnippet {
	title: string;
	durationMinutes: number;
	timeZone: string;
	url: string;
	slots: number[];
}

/**
 * The block "Insert availability" puts into a message: a lead-in, the next
 * open times as a list, and the booking link. Copy comes in already translated
 * (the caller owns i18n); everything interpolated is escaped here.
 */
export function availabilityHtml(
	snippet: AvailabilitySnippet,
	copy: { intro: string; linkLead: string },
	locale: string
): string {
	const items = snippet.slots
		.map(
			(start) =>
				`<li>${escapeHtml(
					formatSlotRange(start, start + snippet.durationMinutes * 60_000, locale, snippet.timeZone)
				)}</li>`
		)
		.join('');
	const url = escapeHtml(snippet.url);
	return (
		`<p>${escapeHtml(copy.intro)}</p>` +
		(items ? `<ul>${items}</ul>` : '') +
		`<p>${escapeHtml(copy.linkLead)} <a href="${url}">${url}</a></p>`
	);
}
