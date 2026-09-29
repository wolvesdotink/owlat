/**
 * Free/busy availability grounding for scheduling replies.
 *
 * A single, read-only, SELF-HOSTED free/busy source: the deployment owner points
 * `CALENDAR_FREEBUSY_ICS_URL` at an ICS/CalDAV subscription feed (their own
 * calendar's private iCal export). When the reader's meeting-intent fires, the
 * scheduling reply framing (mail/ai/scheduling) can then propose the owner's
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

import {
	getTzParts,
	icalDateTimeToEpoch,
	parseICalendar,
	wallClockToEpoch,
} from '@owlat/shared/ical';
import { getOptional } from '../lib/env';
import { buildSchedulingInstruction } from './ai/scheduling';
import { DAY_MS } from '../lib/constants';

/** A busy time range, epoch-ms half-open interval [start, end). */
export interface BusyInterval {
	start: number;
	end: number;
}

/** An open meeting slot the owner could offer, epoch-ms half-open [start, end). */
interface OpenSlot {
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
const SLOT_MS = SLOT_MINUTES * 60 * 1000;
/** How many open slots we surface to the model. */
const MAX_OPEN_SLOTS = 3;
/** Network fetch budget for the feed. */
const FETCH_TIMEOUT_MS = 5000;

/**
 * Extract busy intervals from a raw ICS body. The feed goes through the shared
 * iCalendar parser and only each VEVENT's DTSTART/DTEND are read (free/busy
 * masking); summaries, attendees and every other property are dropped here, so
 * no event content leaves this function. TZID times are converted in their own
 * zone; floating and all-day times are read in `timeZone`, the zone the
 * business-hours slots use. Events without a usable end default to a one-slot
 * block (or a full day for all-day starts). Pure + exported for unit testing.
 */
export function parseIcsBusyIntervals(ics: string, timeZone = 'UTC'): BusyInterval[] {
	const intervals: BusyInterval[] = [];
	for (const event of parseICalendar(ics).events) {
		if (intervals.length >= MAX_BUSY_INTERVALS) break;
		if (!event.start) continue;
		const startMs = icalDateTimeToEpoch(event.start, timeZone);
		if (startMs === null) continue;
		const endMs =
			(event.end ? icalDateTimeToEpoch(event.end, timeZone) : null) ??
			startMs + (event.start.allDay ? DAY_MS : SLOT_MS);
		if (endMs > startMs) intervals.push({ start: startMs, end: endMs });
	}
	return intervals;
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
			const endMs = startMs + SLOT_MS;
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
interface AvailabilityDeps {
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
		if (!/BEGIN:VEVENT/i.test(body)) return [];
		const busy = parseIcsBusyIntervals(body, timeZone);
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
 * Kept here rather than inline in mail/ai/assist.ts so the advisory-AI file stays under
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
