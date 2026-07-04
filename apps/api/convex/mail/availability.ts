/**
 * Free/busy availability grounding for scheduling replies.
 *
 * A single, read-only, SELF-HOSTED free/busy source: the deployment owner points
 * `CALENDAR_FREEBUSY_ICS_URL` at an ICS/CalDAV subscription feed (their own
 * calendar's private iCal export). When the reader's meeting-intent fires, the
 * scheduling reply framing (mail/aiScheduling) can then propose the owner's
 * ACTUAL open slots ("Tue 2pm or Wed 10am?") instead of only echoing the
 * sender's phrases.
 *
 * Privacy posture: the ICS feed is fetched server-side from inside this Convex
 * deployment — the calendar URL and its contents never reach the browser, and no
 * event details other than busy intervals are used. Only free/busy time ranges
 * are derived; event titles, attendees, and descriptions are ignored.
 *
 * FAIL-SOFT: no URL configured, an unreachable feed, or an unparseable body all
 * degrade to an empty slot list — i.e. exactly today's behaviour (the reply then
 * only references the sender's proposed times). This never throws to the caller.
 */

import { getOptional } from '../lib/env';
import { buildSchedulingInstruction } from './aiScheduling';

/** A busy time range, epoch-ms half-open interval [start, end). */
export interface BusyInterval {
	start: number;
	end: number;
}

/** An open meeting slot the owner could offer, epoch-ms half-open [start, end). */
export interface OpenSlot {
	start: number;
	end: number;
}

/** Bounds so a hostile/huge ICS feed can never blow the budget. */
const MAX_ICS_BYTES = 512 * 1024;
const MAX_BUSY_INTERVALS = 2000;
/** How far ahead we look for open slots. */
const HORIZON_DAYS = 14;
/** Local business hours [start, end) in which we offer slots. */
const BUSINESS_START_HOUR = 9;
const BUSINESS_END_HOUR = 17;
/** Length of an offered slot, minutes. */
const SLOT_MINUTES = 60;
/** How many open slots we surface to the model. */
const MAX_OPEN_SLOTS = 3;
/** Network fetch budget for the feed. */
const FETCH_TIMEOUT_MS = 5000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Unfold RFC 5545 folded lines: a CRLF (or LF) followed by a space or tab is a
 * continuation of the previous logical line.
 */
function unfoldIcs(text: string): string[] {
	const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	const rawLines = normalized.split('\n');
	const lines: string[] = [];
	for (const line of rawLines) {
		if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length > 0) {
			lines[lines.length - 1] += line.slice(1);
		} else {
			lines.push(line);
		}
	}
	return lines;
}

/**
 * Parse an ICS date-time property value into an epoch-ms instant and whether it
 * was a date-only (all-day) value. Supports the two forms a self-hosted iCal
 * export emits: UTC `YYYYMMDDTHHMMSSZ`, floating/TZID `YYYYMMDDTHHMMSS` (treated
 * as UTC — good enough for v1 busy-masking), and `VALUE=DATE` `YYYYMMDD`.
 * Returns null if the value is not a shape we understand.
 */
export function parseIcsInstant(value: string): { ms: number; allDay: boolean } | null {
	const v = value.trim();
	const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
	if (dateOnly) {
		const year = Number(dateOnly[1]);
		const month = Number(dateOnly[2]);
		const day = Number(dateOnly[3]);
		return { ms: Date.UTC(year, month - 1, day), allDay: true };
	}
	const dateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
	if (dateTime) {
		const year = Number(dateTime[1]);
		const month = Number(dateTime[2]);
		const day = Number(dateTime[3]);
		const hour = Number(dateTime[4]);
		const minute = Number(dateTime[5]);
		const second = Number(dateTime[6]);
		return { ms: Date.UTC(year, month - 1, day, hour, minute, second), allDay: false };
	}
	return null;
}

/**
 * Extract busy intervals from a raw ICS body. Only VEVENT DTSTART/DTEND are used
 * (free/busy masking); every other property is ignored, so no event content
 * leaves this function. Events without a usable end default to a 1-hour block (or
 * a full day for all-day starts). Pure + exported for unit testing.
 */
export function parseIcsBusyIntervals(ics: string): BusyInterval[] {
	const lines = unfoldIcs(ics);
	const intervals: BusyInterval[] = [];
	let inEvent = false;
	let start: { ms: number; allDay: boolean } | null = null;
	let end: { ms: number; allDay: boolean } | null = null;
	for (const line of lines) {
		if (line === 'BEGIN:VEVENT') {
			inEvent = true;
			start = null;
			end = null;
			continue;
		}
		if (line === 'END:VEVENT') {
			if (inEvent && start) {
				const startMs = start.ms;
				let endMs: number;
				if (end) {
					endMs = end.ms;
				} else if (start.allDay) {
					endMs = startMs + DAY_MS;
				} else {
					endMs = startMs + SLOT_MINUTES * 60 * 1000;
				}
				if (endMs > startMs) {
					intervals.push({ start: startMs, end: endMs });
				}
			}
			inEvent = false;
			start = null;
			end = null;
			continue;
		}
		if (!inEvent) continue;
		const colon = line.indexOf(':');
		if (colon < 0) continue;
		const name = line.slice(0, colon).split(';')[0];
		const value = line.slice(colon + 1);
		if (name === 'DTSTART') {
			start = parseIcsInstant(value);
		} else if (name === 'DTEND') {
			end = parseIcsInstant(value);
		}
		if (intervals.length >= MAX_BUSY_INTERVALS) break;
	}
	return intervals;
}

/** Wall-clock fields of an instant, read in a given IANA timezone. */
function getTzParts(
	ms: number,
	timeZone: string
): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
	const dtf = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
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
		weekday: weekdayMap[get('weekday')] ?? 0,
	};
}

/**
 * Epoch-ms for a wall-clock Y/M/D H:M in the given timezone. Computes the zone's
 * offset at that instant via {@link getTzParts} and corrects for it (one refine
 * pass handles the DST-boundary case well enough for slot proposals).
 */
function wallClockToEpoch(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	timeZone: string
): number {
	const asUtc = Date.UTC(year, month - 1, day, hour, minute);
	const parts = getTzParts(asUtc, timeZone);
	const back = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
	const offset = back - asUtc;
	return asUtc - offset;
}

function overlapsBusy(start: number, end: number, busy: BusyInterval[]): boolean {
	for (const b of busy) {
		if (start < b.end && end > b.start) return true;
	}
	return false;
}

/**
 * Compute up to {@link MAX_OPEN_SLOTS} open business-hours slots that don't
 * overlap the busy intervals, looking forward from `now` over the horizon,
 * skipping weekends and past slots. Pure + exported for unit testing.
 */
export function computeOpenSlots(busy: BusyInterval[], now: number, timeZone: string): OpenSlot[] {
	const slots: OpenSlot[] = [];
	for (let dayOffset = 0; dayOffset < HORIZON_DAYS; dayOffset++) {
		const probe = getTzParts(now + dayOffset * DAY_MS, timeZone);
		if (probe.weekday === 0 || probe.weekday === 6) continue;
		for (let hour = BUSINESS_START_HOUR; hour < BUSINESS_END_HOUR; hour++) {
			const startMs = wallClockToEpoch(probe.year, probe.month, probe.day, hour, 0, timeZone);
			const endMs = startMs + SLOT_MINUTES * 60 * 1000;
			if (startMs <= now) continue;
			if (overlapsBusy(startMs, endMs, busy)) continue;
			slots.push({ start: startMs, end: endMs });
			if (slots.length >= MAX_OPEN_SLOTS) return slots;
		}
	}
	return slots;
}

/** Human-readable slot labels ("Tue, Jul 8, 2:00 PM") in the owner's timezone. */
export function formatOpenSlots(slots: OpenSlot[], timeZone: string): string[] {
	const fmt = new Intl.DateTimeFormat('en-US', {
		timeZone,
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
	});
	return slots.map((s) => fmt.format(new Date(s.start)));
}

/** Injectable seams so the unit test can drive the fetch without a network. */
export interface AvailabilityDeps {
	fetchImpl?: typeof fetch;
	now?: number;
	icsUrl?: string;
	timeZone?: string;
}

/**
 * Fetch the configured free/busy feed and return the owner's next open slots as
 * human-readable labels. FAIL-SOFT: any missing config, network error, oversize
 * body, or parse failure returns `[]` (today's behaviour). Never throws.
 */
export async function fetchOpenSlots(deps: AvailabilityDeps = {}): Promise<string[]> {
	const icsUrl = deps.icsUrl ?? getOptional('CALENDAR_FREEBUSY_ICS_URL');
	if (!icsUrl) return [];
	const timeZone = deps.timeZone ?? getOptional('CALENDAR_TIMEZONE') ?? 'UTC';
	const now = deps.now ?? Date.now();
	const doFetch = deps.fetchImpl ?? globalThis.fetch;
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
		let body: string;
		try {
			const res = await doFetch(icsUrl, { signal: controller.signal });
			if (!res.ok) return [];
			body = (await res.text()).slice(0, MAX_ICS_BYTES);
		} finally {
			clearTimeout(timer);
		}
		if (!body.includes('BEGIN:VEVENT')) return [];
		const busy = parseIcsBusyIntervals(body);
		const slots = computeOpenSlots(busy, now, timeZone);
		return formatOpenSlots(slots, timeZone);
	} catch {
		return [];
	}
}

/**
 * Orchestrate the scheduling-focused reply instruction for
 * {@link import('./ai').suggestReplies}: fetch the owner's real open slots
 * (fail-soft — no configured source or any error yields no grounding) and fold
 * them into the fixed scheduling framing from {@link buildSchedulingInstruction}.
 *
 * Kept here rather than inline in mail/ai.ts so the advisory-AI file stays under
 * the file-size ratchet, and because the free/busy fetch is this module's
 * concern. `proposedTimes` are the verbatim, untrusted sender phrases; the
 * returned string is prompt-ready. Never throws (fetchOpenSlots is fail-soft).
 */
export async function buildSchedulingReplyInstruction(
	proposedTimes: string[],
	deps: AvailabilityDeps = {}
): Promise<string> {
	const openSlots = await fetchOpenSlots(deps);
	return buildSchedulingInstruction(proposedTimes, openSlots);
}
